// Canonical planning and an immutable executor binding. Opaque project commands
// run only after identity/authority/coverage checks and inside host admission.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { plainDirectory, readPlainFile } from '../lib/files.mjs';
import { readDeclared } from '../lanes/validation.mjs';
import { runGateSync } from '../test-slot/run.mjs';
import { resolveGateLimits, gateHistoryKey } from '../test-slot/limits.mjs';
import { withCanonicalSnapshot } from '../settle/test-plan.mjs';
import { executionIdentity } from './execution-identity.mjs';
import { selectDeclared } from './declared-selection.mjs';
import { remaining, git, captureGit } from './declared-support.mjs';
import { runDeclaredCommand, prepareDeclared, recoverCommandEvidence } from './declared-command.mjs';
import { observePaths } from './declared-inputs.mjs';
import { hash, snapshotDeclaration, sameDeclaration, gateDefinition, EXECUTION_SCHEMA, ATTEMPT_SCHEMA, MAX_EXECUTION_BYTES, MAX_PLAN_BYTES, refuse } from './declaration.mjs';

const runner = fileURLToPath(new URL('./declared-runner.mjs', import.meta.url));
export function assertExecutionBinding(spec, { current = true } = {}) {
  remaining(spec.deadline);
  executionIdentity({ canonical: spec.repo, identity: spec.common }, { bound: spec.identity });
  if (current) sameDeclaration(spec.declaration, readDeclared(spec.repo));
  const before = captureGit(spec.cwd, spec.common, spec.deadline);
  if (before.head !== spec.candidate || before.branch !== spec.branch || git(spec.repo, ['rev-parse', 'HEAD'], spec.deadline) !== spec.base) throw refuse('candidate, branch or canonical base changed');
  return before;
}
export function serializeExecution(spec) {
  const bytes = JSON.stringify(spec);
  if (Buffer.byteLength(bytes) > MAX_EXECUTION_BYTES) throw refuse('immutable execution argv exceeds 96 KiB; no binding fields may be omitted');
  return bytes;
}
function attemptLimits({ common, owner, env, profile }) {
  const value = owner.value;
  return resolveGateLimits({ common, tier: 'promotion', command: ['/bin/sh', '-c', value.promotion],
    historyKey: gateHistoryKey('promotion', ['/bin/sh', '-c', value.promotion]), env,
    timeoutSeconds: profile?.timeoutSeconds ?? (typeof value.timeout_seconds === 'object' ? value.timeout_seconds.promotion : value.timeout_seconds),
    idleTimeoutSeconds: profile?.idleTimeoutSeconds ?? (typeof value.idle_timeout_seconds === 'object' ? value.idle_timeout_seconds.promotion : value.idle_timeout_seconds) });
}
// The watchdog contains the whole planning phase, including synchronous Git,
// snapshot I/O and hashing. Leaf deadlines alone cannot stop a blocked parent.
export function planDeclaredGateBounded(context) {
  const { onUpdate = () => {}, evidence, env, profile, ...input } = context;
  executionIdentity({ canonical: input.repo, identity: input.common }, { bound: input.identity });
  const limits = attemptLimits(context), deadline = Date.now() + Math.ceil(limits.wall_seconds * 1000);
  const directory = plainDirectory(path.join(input.common, 'promote/planning', randomUUID()));
  const file = path.join(directory, 'bound-planning.json');
  const bound = { ...input, owner: snapshotDeclaration(input.owner), limits, deadline };
  delete bound.evidence;
  const serialized = JSON.stringify(bound);
  if (Buffer.byteLength(serialized) > MAX_EXECUTION_BYTES) throw refuse('immutable planning argv exceeds 96 KiB');
  evidence.planning = { file, limits, deadline, binding_hash: hash(bound) }; onUpdate();
  const result = runGateSync('declared canonical planning', [process.execPath, fileURLToPath(new URL('./declared-plan-runner.mjs', import.meta.url)), serialized, file], {
    cwd: input.repo, env, stdio: 'inherit', retryTimeout: false,
    executionReceipt: path.join(directory, 'planning.execution.json'), timeoutSeconds: remaining(deadline) / 1000, idleTimeoutSeconds: limits.idle_seconds });
  let saved;
  try { saved = JSON.parse(readPlainFile(file)); } catch { /* Keep the immutable input and interrupted receipt. */ }
  if (saved?.evidence) Object.assign(evidence, saved.evidence);
  recoverCommandEvidence(evidence, result.gateTimeout ?? null); onUpdate();
  if (result.error || result.status !== 0 || result.signal || result.gateTimeout || saved?.binding_hash !== hash(bound) || !saved?.spec || saved.error) {
    const error = result.gateTimeout || saved?.code === 'DECLARED_GATE_TIMEOUT' ? Object.assign(Error('DECLARED_GATE_TIMEOUT: canonical planning exceeded attempt limits'), { code: 'DECLARED_GATE_TIMEOUT' })
      : refuse(saved?.error ?? 'canonical planning interrupted; inspect bound planning evidence');
    throw error;
  }
  return { spec: saved.spec, plan: saved.plan, deadline, limits, env };
}
export function planDeclaredGate({ repo, common, base, cwd, candidate, identity, owner, required, changed, jobs = [], env, profile, evidence, onUpdate = () => {}, selectionOnly = false, limits: suppliedLimits, deadline: suppliedDeadline }) {
  const value = owner.value;
  const limits = suppliedLimits ?? attemptLimits({ common, owner, env, profile });
  const deadline = suppliedDeadline ?? Date.now() + Math.ceil(limits.wall_seconds * 1000);
  const directory = plainDirectory(path.join(common, 'promote/declared-attempts', randomUUID()));
  const captured = captureGit(cwd, common, deadline);
  if (captured.head !== candidate) throw refuse('candidate changed before planning');
  const spec = { schema: EXECUTION_SCHEMA, repo, common, base, candidate, cwd, branch: captured.branch, identity,
    declaration: snapshotDeclaration(owner), required, changed: [...new Set(changed)].sort(), jobs, limits, deadline, directory };
  const guard = () => assertExecutionBinding(spec);
  guard();
  Object.assign(evidence, { schema: ATTEMPT_SCHEMA, project: common, execution_identity: identity, jobs, base, candidate,
    changed: spec.changed, declaration: spec.declaration, limits, deadline, directory, commands: evidence.commands ?? [] }); onUpdate();
  let selected = { schema: 'promotion-gates/v1', gates: [], deferred: [], unknown: [] };
  if (value.promotion_tests) {
    selected = withCanonicalSnapshot({ repo, base, deadline }, snapshot => {
      const source = observePaths(snapshot, ['.'], deadline);
      evidence.planner_snapshot = { base, root: snapshot, digest: source.digest, paths: source.paths, bytes: source.bytes }; onUpdate();
      const snapshotGuard = () => {
        guard();
        // Compare every captured tracked file. Preparation may add ignored
        // dependencies/build outputs, but may not edit canonical source bytes.
        for (const [name, mode, digest] of tracked) {
          const file = path.join(snapshot, name), stat = fs.lstatSync(file);
          if (!stat.isFile() || (stat.mode & 0o777) !== mode || hash(readPlainFile(file, null)) !== digest) throw refuse('canonical snapshot tracked source changed');
          remaining(deadline);
        }
      };
      const tracked = [];
      const collect = (directory, prefix = '') => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          remaining(deadline);
          const name = prefix + entry.name, file = path.join(directory, entry.name);
          if (entry.isDirectory()) collect(file, `${name}/`);
          else tracked.push([name, fs.lstatSync(file).mode & 0o777, hash(readPlainFile(file, null))]);
        }
      };
      collect(snapshot);
      const context = { cwd: snapshot, env, deadline, limits, directory, evidence, onUpdate, guard: snapshotGuard };
      prepareDeclared(value.promotion_tests.prepare, context);
      const input = JSON.stringify({ schema: 'promotion-gates-input/v1', base, candidate, candidate_root: cwd, changed: spec.changed, required });
      if (Buffer.byteLength(input) > MAX_PLAN_BYTES) throw refuse('planner input exceeds 1 MiB');
      const result = runDeclaredCommand({ ...context, argv: value.promotion_tests.command, kind: 'planner', input, capMs: 20000, bounded: true });
      if (!result.ok || result.oversized) throw Object.assign(refuse(`canonical planner failed; log=${result.row.log}`), { commandEvidence: result.row });
      return JSON.parse(result.stdout);
    });
  }
  const plan = selectDeclared(selected, value, required);
  spec.selection = plan;
  spec.commands = [{ id: 'promotion', definition: gateDefinition(value, 'promotion') }, ...plan.gates.map(row => ({ id: row.id, definition: gateDefinition(value, row.id) }))];
  // Definitions contain input specs but never environment values.
  guard(); serializeExecution(spec);
  evidence.selection = plan; evidence.spec_hash = hash(spec); onUpdate();
  return { spec, plan, deadline, limits, env, selectionOnly };
}
export function executeDeclaredGate({ spec, env, evidence, onUpdate = () => {}, recheck = false }) {
  const command = serializeExecution(spec), resultFile = path.join(spec.directory, 'result.json');
  const executionReceipt = path.join(spec.directory, `${recheck ? 'recheck' : 'executor'}.${randomUUID()}.execution.json`);
  assertExecutionBinding(spec);
  const result = runGateSync('declared gate executor', [process.execPath, runner, ...(recheck ? ['--recheck'] : []), command, resultFile], {
    cwd: spec.cwd, env, stdio: 'inherit', retryTimeout: false, executionReceipt,
    timeoutSeconds: remaining(spec.deadline) / 1000, idleTimeoutSeconds: spec.limits.idle_seconds });
  let saved;
  try { saved = JSON.parse(readPlainFile(resultFile)); } catch { /* Interrupted child may have only partial evidence. */ }
  if (saved) { recoverCommandEvidence(saved, result.gateTimeout ?? null); evidence.execution = saved; onUpdate(); }
  const before = captureGit(spec.cwd, spec.common, spec.deadline);
  const exit = result.status ?? 1;
  if (!saved || saved.spec_hash !== hash(spec) || saved.schema !== ATTEMPT_SCHEMA || !saved.finished_at || saved.error || result.error || exit !== 0 || result.signal || result.gateTimeout) {
    const error = result.gateTimeout || saved?.code === 'DECLARED_GATE_TIMEOUT' ? Object.assign(Error('DECLARED_GATE_TIMEOUT: declared execution exceeded attempt limits'), { code: 'DECLARED_GATE_TIMEOUT' })
      : refuse(saved?.error ?? 'declared executor interrupted; no completed green evidence');
    throw Object.assign(error, { executionEvidence: saved, executionReceipt });
  }
  assertExecutionBinding(spec);
  const failed = saved.gates.find(row => row.outcome === 'failed');
  const logs = evidence.commands.concat(saved.commands).map(row => ({ kind: row.kind, command: row.command, cwd: row.cwd,
    exit_code: row.exit_code, signal: row.signal, log: row.log, log_hash: row.log_hash, stderr_log: row.stderr_log, stderr_hash: row.stderr_hash }));
  const log = path.join(spec.directory, `${recheck ? 'recheck' : 'attempt'}.${randomUUID()}.log`);
  const text = JSON.stringify({ spec_hash: hash(spec), logs, gates: saved.gates }, null, 2) + '\n';
  fs.writeFileSync(log, text, { flag: 'wx', mode: 0o600 });
  const timed = failed?.execution?.gate_timeout;
  const gate = { schema: ATTEMPT_SCHEMA, ...before, declared_gate: spec, declaration: spec.declaration.source,
    command_order: spec.commands.map(row => row.definition.command), command: spec.commands.map(row => row.definition.command).join('\n'),
    node_version: process.version, tap_totals: [...evidence.commands, ...saved.commands].flatMap(row => row.tap_totals ?? []),
    exit_code: failed?.execution?.exit_code ?? (failed ? 1 : 0), signal: failed?.execution?.signal ?? null,
    outcome: timed ? 'timeout' : failed ? 'red' : 'green', gate_timeout: timed ?? null,
    started_at: saved.started_at, finished_at: saved.finished_at, duration_s: (Date.parse(saved.finished_at) - Date.parse(saved.started_at)) / 1000,
    log, log_kind: 'attempt-manifest', log_hash: hash(text), execution_receipt: executionReceipt, execution_hash: hash(readPlainFile(executionReceipt)),
    gates: saved.gates, result: resultFile, result_hash: hash(readPlainFile(resultFile)),
    reused: saved.gates.every(row => row.outcome === 'reused'), executed: saved.gates.some(row => row.outcome === 'executed' || row.outcome === 'failed') };
  return gate;
}
export function recheckDeclaredGate(context) { return executeDeclaredGate({ ...context, recheck: true }); }
