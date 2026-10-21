// The declared attempt: prepared canonical planner, separate candidate runtime,
// literal validated selection and bounded foreground execution.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withCanonicalSnapshot } from '../settle/test-plan.mjs';
import { runGateSync } from '../test-slot/run.mjs';
import { resolveGateLimits } from '../test-slot/limits.mjs';
import { hash, refuse, MAX_PLAN_BYTES, SELECTION_SCHEMA, sameDeclaration } from './declaration.mjs';
import { readDeclared } from '../lanes/validation.mjs';
import { bindRequirements, validateSelection } from './declared-selection.mjs';
import { policyBinding, assertCandidatePolicy, assertRunnerPolicy, within } from './declared-policy.mjs';
import { projectEnvironment, remaining, runtimeIdentity, dependencyIdentity } from './declared-runtime.mjs';

const executor = fileURLToPath(new URL('./declared-runner.mjs', import.meta.url));
const plannerDriver = fileURLToPath(new URL('./declared-planner.mjs', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function sourceInventory(root) {
  const result = [];
  const visit = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const local = path.posix.join(relative, name), file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file, local);
      else if (stat.isFile()) result.push([local, stat.mode & 0o777, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
      else throw refuse('canonical source snapshot contains a symlink');
    }
  };
  visit(root); return result;
}
function unchangedSnapshot(root, files) {
  for (const [name, mode, digest] of files) {
    const file = within(root, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o777) !== mode || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) throw refuse(`preparation changed canonical source: ${name}`);
  }
}
function snapshotLinks(root, deadline) {
  const visit = directory => {
    remaining(deadline);
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) within(root, path.relative(root, file));
      else if (stat.isDirectory()) visit(file);
    }
  };
  visit(root);
}
function prepareSteps(steps, { cwd, env, common, deadline, idleTimeoutSeconds, record }) {
  for (const step of steps ?? []) {
    if (step.unless !== undefined && fs.existsSync(path.join(cwd, step.unless))) { within(cwd, step.unless); continue; }
    const item = { kind: 'prepare', cwd, command: ['/bin/sh', '-c', step.run], started_at: new Date().toISOString() };
    record(item);
    const result = runGateSync('declared preparation', item.command, { cwd, env, common, tier: 'declared-prepare',
      timeoutSeconds: remaining(deadline) / 1000, idleTimeoutSeconds, retryTimeout: false, stdio: 'inherit' });
    Object.assign(item, { finished_at: new Date().toISOString(), exit_code: result.status, signal: result.signal ?? null,
      timeout: result.gateTimeout ?? null, error: result.error?.code ?? null });
    record();
    if (result.error || result.status !== 0 || result.signal) throw Object.assign(refuse('declared preparation failed or timed out'), {
      ...(result.gateTimeout ? { code: 'DECLARED_GATE_TIMEOUT', gateTimeout: result.gateTimeout } : {}) });
  }
}
export function declaredDeadline({ common, owner, env, profile }) {
  const value = owner.value;
  const tierLimit = key => typeof value[key] === 'object' ? value[key].promotion : value[key];
  const limits = resolveGateLimits({ common, tier: 'promotion', command: ['/bin/sh', '-c', value.promotion], env,
    timeoutSeconds: profile?.timeoutSeconds ?? tierLimit('timeout_seconds'), idleTimeoutSeconds: profile?.idleTimeoutSeconds ?? tierLimit('idle_timeout_seconds') });
  return { deadline: Date.now() + limits.wall_seconds * 1000, limits };
}
export function planDeclaredGate({ repo, base, cwd, candidate, owner, required = [], changed, env = process.env, common, identity, profile,
  deadline, limits, evidence = { commands: [] }, onUpdate = () => {}, selectionOnly = false }) {
  sameDeclaration(owner, readDeclared(repo, { env }));
  if (git(cwd, ['rev-parse', 'HEAD']) !== candidate || git(cwd, ['status', '--porcelain', '--untracked-files=all'])) throw refuse('candidate must be clean and at its captured commit');
  const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  const value = owner.value;
  ({ deadline, limits } = deadline === undefined ? declaredDeadline({ common, owner, env, profile }) : { deadline, limits });
  Object.assign(evidence, { schema: 'declared-gate-attempt/v1', base, candidate, declaration: owner.source,
    identity, deadline_at: new Date(deadline).toISOString(), limits });
  const record = item => { if (item) evidence.commands.push(item); onUpdate(evidence); };
  record();
  const bindingFor = row => policyBinding(repo, base, value, [row], deadline);
  required = bindRequirements(required, value, bindingFor);
  let plan;
  if (value.promotion_tests) plan = withCanonicalSnapshot({ repo, base, deadline }, snapshot => {
    const sources = sourceInventory(snapshot), plannerEnv = projectEnvironment(env, { candidate: cwd, snapshot });
    evidence.planner_source = { base, digest: hash(sources), paths: sources.length };
    prepareSteps(value.promotion_tests.prepare, { cwd: snapshot, env: plannerEnv, common, deadline,
      idleTimeoutSeconds: limits.idle_seconds, record });
    unchangedSnapshot(snapshot, sources);
    snapshotLinks(snapshot, deadline);
    const runtime = runtimeIdentity(value.promotion_tests.command, { cwd: snapshot, env: plannerEnv, deadline, roots: [[snapshot, '$planner']] });
    evidence.planner_runtime = runtime;
    evidence.planner_dependencies = dependencyIdentity(snapshot, deadline);
    const input = { schema: 'promotion-selection-input/v1', base, candidate, candidate_root: fs.realpathSync(cwd),
      changed: [...new Set(changed)].sort(), command: value.promotion, required };
    const command = { kind: 'planner', command: value.promotion_tests.command, started_at: new Date().toISOString(), input: { ...input, candidate_root: '$candidate' } };
    record(command);
    const result = runGateSync('declared planner', [process.execPath, plannerDriver, JSON.stringify(value.promotion_tests.command)], {
      cwd: snapshot, env: plannerEnv, input: JSON.stringify(input), encoding: 'utf8', common, tier: 'declared-planner',
      timeoutSeconds: Math.min(20000, remaining(deadline)) / 1000, idleTimeoutSeconds: limits.idle_seconds,
      maxBuffer: MAX_PLAN_BYTES * 2, retryTimeout: false });
    if (result.stderr) process.stderr.write(result.stderr);
    Object.assign(command, { finished_at: new Date().toISOString(), exit_code: result.status, signal: result.signal ?? null,
      error: result.error?.code ?? null, timeout: result.gateTimeout ?? null,
      stdout_bytes: Buffer.byteLength(result.stdout ?? ''), stdout_digest: hash(result.stdout ?? '') }); record();
    if (result.error || result.status !== 0 || result.signal) throw refuse('planner failed, exceeded 20 seconds or exceeded 1 MiB');
    unchangedSnapshot(snapshot, sources);
    snapshotLinks(snapshot, deadline);
    if (hash(dependencyIdentity(snapshot, deadline)) !== hash(evidence.planner_dependencies)) throw refuse('planner changed its locked dependencies');
    try { return validateSelection(JSON.parse(result.stdout), { declaration: value, required }); }
    catch (error) { throw error.code ? error : refuse(`malformed planner JSON: ${error.message}`); }
  });
  else plan = validateSelection({ schema: SELECTION_SCHEMA, files: [], steps: [] }, { declaration: value, required });
  evidence.selection = plan;
  if (selectionOnly) { record(); return { plan, evidence }; }
  const policy = policyBinding(repo, base, value, plan.steps, deadline);
  assertCandidatePolicy(repo, candidate, policy, deadline);
  const candidateEnv = projectEnvironment(env);
  candidateEnv.PATH = [path.join(cwd, 'node_modules/.bin'), candidateEnv.PATH ?? ''].join(path.delimiter);
  prepareSteps(value.gate?.prepare, { cwd, env: candidateEnv, common, deadline, idleTimeoutSeconds: limits.idle_seconds, record });
  if (git(cwd, ['rev-parse', 'HEAD']) !== candidate || git(cwd, ['symbolic-ref', '--short', 'HEAD']) !== branch ||
      git(cwd, ['status', '--porcelain', '--untracked-files=all'])) throw refuse('candidate changed during preparation');
  assertRunnerPolicy(cwd, value, plan.steps, policy);
  const runtime = Object.fromEntries(Object.entries(value.runners).map(([name, runner]) => [name,
    runtimeIdentity(runner.command, { cwd: within(cwd, runner.cwd), env: candidateEnv, deadline, roots: [[cwd, '$candidate']] })]));
  evidence.runtime = runtime;
  evidence.dependencies = dependencyIdentity(cwd, deadline);
  const spec = { schema: 'declared-gate-execution/v1', base, candidate, common, identity, declaration: owner, selection: plan,
    policy, runtime: Object.fromEntries(Object.entries(runtime).map(([id, facts]) => [id, facts.map(fact => fact.binding)])),
    dependencies: evidence.dependencies,
    planner: { source: evidence.planner_source ?? null, runtime: (evidence.planner_runtime ?? []).map(fact => fact.binding), dependencies: evidence.planner_dependencies ?? null } };
  const serialized = JSON.stringify(spec);
  if (Buffer.byteLength(serialized) > MAX_PLAN_BYTES) throw refuse('complete execution selection exceeds 1 MiB');
  const command = `${quote(process.execPath)} ${quote(executor)} ${quote(serialized)}`;
  evidence.binding = hash(spec); record();
  return { plan, spec, command, env: candidateEnv, deadline, limits, evidence };
}
export function executedCommands(gate) {
  const rows = [];
  if (!gate?.log) return rows;
  for (const line of fs.readFileSync(gate.log, 'utf8').split('\n')) {
    const match = /^DECLARED_(COMMAND|EXIT) (.*)$/.exec(line);
    if (!match) continue;
    let row;
    try { row = JSON.parse(match[2]); } catch { continue; }
    if (match[1] === 'COMMAND') rows.push({ ...row, finished_at: null, exit_code: null, signal: null });
    else if (rows.length && hash(rows.at(-1).command) === hash(row.command) && rows.at(-1).cwd === row.cwd) Object.assign(rows.at(-1), row);
  }
  if (rows.length && !rows.at(-1).finished_at) Object.assign(rows.at(-1), { signal: gate.signal, timeout: gate.gate_timeout, finished_at: gate.finished_at });
  return rows;
}
export function recheckDeclaredGate({ repo, cwd, owner, spec, env, deadline }) {
  env = projectEnvironment(env);
  env.PATH = [path.join(cwd, 'node_modules/.bin'), env.PATH ?? ''].join(path.delimiter);
  const current = readDeclared(repo, { env });
  sameDeclaration(owner, current);
  if (current.source.revision !== spec.base) throw refuse('canonical base changed during the attempt');
  if (git(cwd, ['rev-parse', 'HEAD']) !== spec.candidate || git(cwd, ['status', '--porcelain', '--untracked-files=all'])) throw refuse('candidate changed during the attempt');
  assertCandidatePolicy(repo, spec.candidate, spec.policy, deadline);
  assertRunnerPolicy(cwd, owner.value, spec.selection.steps, spec.policy);
  if (hash(dependencyIdentity(cwd, deadline)) !== hash(spec.dependencies)) throw refuse('locked runtime dependencies changed during the attempt');
  for (const [name, bindings] of Object.entries(spec.runtime)) {
    const runner = owner.value.runners[name];
    const facts = runtimeIdentity(runner.command, { cwd: within(cwd, runner.cwd), env, deadline, roots: [[cwd, '$candidate']] });
    if (hash(facts.map(fact => fact.binding)) !== hash(bindings)) throw refuse('runtime changed during the attempt');
  }
}
