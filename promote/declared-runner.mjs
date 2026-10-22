#!/usr/bin/env node
// One literal argv binding is the execution authority. The result path carries
// outcomes only; editing it cannot select a command or reduce required work.
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/cli-help.mjs';
import { readPlainFile, writeFileAtomic } from '../lib/files.mjs';
import { readDeclared } from '../lanes/validation.mjs';
import { hash, closed, validateDeclared, sameDeclaration, gateDefinition, EXECUTION_SCHEMA, ATTEMPT_SCHEMA, MAX_EXECUTION_BYTES, refuse } from './declaration.mjs';
import { selectDeclared, unionRequirements } from './declared-selection.mjs';
import { remaining, contained } from './declared-support.mjs';
import { assertExecutionBinding, serializeExecution } from './declared-gates.mjs';
import { refuseDeclaredGatesV2 } from './declared-inert.mjs';
import { runDeclaredCommand, prepareDeclared } from './declared-command.mjs';
import { inputEligibility, gateEnvironment, preparationEnvironment, observation, missDimension } from './declared-inputs.mjs';
import { withReceiptLock, findSource, publishSource, verifySource, validCommandEvidence } from './declared-receipts.mjs';

export function validateExecution(spec) {
  refuseDeclaredGatesV2();
  closed(spec, ['schema', 'repo', 'common', 'base', 'candidate', 'cwd', 'branch', 'identity', 'declaration', 'required', 'changed', 'jobs', 'limits', 'deadline', 'directory', 'selection', 'commands'], 'execution binding');
  serializeExecution(spec);
  if (spec.schema !== EXECUTION_SCHEMA || !Array.isArray(spec.commands) || !spec.commands.length) throw refuse('unsupported immutable execution binding');
  const value = validateDeclared(spec.declaration.value);
  if (spec.jobs?.length && hash(unionRequirements(spec.jobs.map(row => ({ requiredTests: row.required })))) !== hash(spec.required)) throw refuse('captured jobs and required union differ');
  // Re-validate the normalized selection from literal IDs, stripping only the
  // mechanically derived coverage/required/budget accounting fields.
  const selection = spec.selection;
  const plan = selectDeclared({ schema: selection.schema, gates: selection.gates, deferred: selection.deferred, unknown: selection.unknown,
    budget: { extras_ms: selection.budget.extras_ms, max_extra_gates: selection.budget.max_extra_gates } }, value, spec.required);
  if (hash(plan) !== hash(selection)) throw refuse('captured selection changed');
  const expected = [{ id: 'promotion', definition: gateDefinition(value, 'promotion') }, ...plan.gates.map(row => ({ id: row.id, definition: gateDefinition(value, row.id) }))];
  if (hash(spec.commands) !== hash(expected)) throw refuse('captured command order/definition changed');
  if (path.dirname(spec.directory) !== path.join(spec.common, 'promote/declared-attempts') || fs.realpathSync(spec.directory) !== spec.directory) throw refuse('attempt evidence directory escaped');
  assertExecutionBinding(spec);
  return value;
}
export function runDeclaredExecution(spec, file, { recheck = false, env = process.env } = {}) {
  validateExecution(spec);
  if (file !== path.join(spec.directory, 'result.json')) throw refuse('result path is outside the immutable attempt');
  const owner = readDeclared(spec.repo);
  sameDeclaration(spec.declaration, owner);
  const value = owner.value;
  // Restore literal values only from the still-matching owner, never a receipt.
  env = { ...env, ...value.gate?.env };
  const guard = () => assertExecutionBinding(spec);
  let state = recheck ? JSON.parse(readPlainFile(file)) : { schema: ATTEMPT_SCHEMA, spec_hash: hash(spec), started_at: new Date().toISOString(),
    commands: [], gates: spec.commands.map(row => ({ id: row.id, outcome: 'not reached' })) };
  if (state.schema !== ATTEMPT_SCHEMA || state.spec_hash !== hash(spec) || !Array.isArray(state.commands) || !Array.isArray(state.gates) || state.gates.length !== spec.commands.length || state.gates.some((row, i) => row.id !== spec.commands[i].id)) throw refuse('execution result binding changed');
  const save = () => writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n', 0o600);
  const context = { deadline: spec.deadline, limits: spec.limits, directory: spec.directory, evidence: state, onUpdate: save, guard };
  const definitions = spec.commands.map(row => row.definition), prep = preparationEnvironment(value, definitions, env);
  const probes = (definition, gateEnv) => {
    const found = {};
    for (const [name, command] of Object.entries(definition.inputs.toolchains)) {
      const result = runDeclaredCommand({ ...context, command, cwd: contained(spec.cwd, definition.cwd), env: gateEnv, kind: 'version-probe', bounded: true, capMs: 20000 });
      if (!result.ok || result.oversized || !result.stdout.trim()) return { miss: `toolchain probe unavailable: ${name}` };
      found[name] = { command, output_digest: result.output_digest };
    }
    return { probes: found };
  };
  const observe = (definition, gateEnv) => {
    const version = probes(definition, gateEnv);
    if (version.miss) return version;
    return observation({ root: spec.cwd, definition, declaration: value, identity: spec.identity, env: gateEnv,
      probes: version.probes, deadline: spec.deadline, limits: spec.limits });
  };
  const execute = (bound, row, { force = false } = {}) => {
    const definition = bound.definition;
    const eligibility = value.receipt_reuse === 'always-execute' ? 'policy always-execute' : inputEligibility(definition.inputs, value.gate?.env);
    const ineligible = eligibility ?? (!state.preparation_reusable ? 'shared preparation environment is incompatible' : null);
    const gateEnv = ineligible ? env : gateEnvironment(env, definition.inputs);
    const before = ineligible ? { miss: ineligible } : observe(definition, gateEnv);
    row.reuse = { outcome: 'miss', reason: before.miss ?? (force ? 'reused inputs changed before integration' : 'no completed executed source'), compared: before.digests ?? null };
    const perform = directory => {
      if (!before.miss && !force) {
        const candidate = findSource(directory, before);
        if (candidate.hit) {
          // Recheck observations while holding the receipt lock before accepting
          // a hit. There is no unbounded retry on changing inputs.
          const checked = observe(definition, gateEnv);
          if (!checked.miss && checked.key === before.key) {
            Object.assign(row, { outcome: 'reused', source: candidate.hit.file, source_candidate: candidate.hit.source.candidate,
              source_base: candidate.hit.source.base, source_log: candidate.hit.source.execution.log, observation: checked,
              reuse: { outcome: 'hit', reason: 'declared input digests identical', compared: checked.digests } });
            save(); return;
          }
          row.reuse.reason = checked.miss ?? `inputs changed during lookup: ${missDimension(before, checked)}`;
        } else row.reuse.reason = candidate.miss;
      }
      for (const key of ['source', 'source_candidate', 'source_base', 'source_log', 'observation', 'after', 'integration_observation']) delete row[key];
      const result = runDeclaredCommand({ ...context, command: definition.command, cwd: contained(spec.cwd, definition.cwd), env: gateEnv, kind: `gate:${bound.id}` });
      Object.assign(row, { outcome: result.ok ? 'executed' : 'failed', execution: result.row });
      if (!before.miss && result.ok) {
        const after = observe(definition, gateEnv);
        row.observation = before; row.after = after;
        if (!after.miss && before.key === after.key) {
          const source = publishSource(directory, { before, after, execution: result.row, spec, gate: bound.id });
          if (source) row.source = source;
        } else row.reuse.unstable = after.miss ?? `inputs changed during execution: ${missDimension(before, after)}`;
      }
      save();
    };
    if (before.miss) perform(null);
    else withReceiptLock(spec.common, before.key, spec.deadline, perform);
  };
  const recheckHits = () => {
    for (let index = 0; index < spec.commands.length; index++) {
      const row = state.gates[index], bound = spec.commands[index];
      if (row.outcome === 'executed') {
        if (!validCommandEvidence(row.execution)) throw refuse('executed command evidence changed');
        continue;
      }
      if (row.outcome !== 'reused') continue;
      const envForGate = gateEnvironment(env, bound.definition.inputs);
      const now = observe(bound.definition, envForGate);
      const source = !now.miss && now.key === row.observation?.key && verifySource(spec.common, row.source, now, spec.deadline);
      if (source) { row.integration_observation = now; save(); continue; }
      if (row.reexecuted) throw refuse('reused inputs remain unstable; attempt held');
      row.history ??= []; row.history.push(structuredClone({ ...row, history: undefined }));
      row.reexecuted = true;
      // The saved pass is no longer authoritative. Execute once under current
      // inputs, or the shared deadline holds the attempt; never loop.
      execute(bound, row, { force: true });
      if (row.outcome !== 'executed') return false;
      // A later forced command may invalidate an earlier hit. Start the
      // comparison again after every execution. Each restart consumes one
      // reused row, so at most commands.length commands can be forced.
      index = -1;
    }
    return true;
  };
  try {
    remaining(spec.deadline); save();
    if (!recheck) {
      state.preparation_reusable = prep.reusable;
      prepareDeclared(value.gate?.prepare, { ...context, cwd: spec.cwd, env: prep.env });
      for (let index = 0; index < spec.commands.length; index++) {
        execute(spec.commands[index], state.gates[index]);
        if (state.gates[index].outcome === 'failed') break;
      }
    } else {
      if (!state.finished_at || state.error || state.gates.some(row => !['executed', 'reused'].includes(row.outcome))) throw refuse('unfinished execution cannot certify integration');
    }
    if (!state.gates.some(row => row.outcome === 'failed')) recheckHits();
    guard();
    state.finished_at = new Date().toISOString(); save();
    return state;
  } catch (error) {
    state.error = error.message; state.code = error.code ?? null; state.finished_at = new Date().toISOString(); save(); throw error;
  }
}
if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2), recheck = args[0] === '--recheck';
    if (recheck) args.shift();
    if (args.length !== 2 || Buffer.byteLength(args[0]) > MAX_EXECUTION_BYTES) throw refuse('invalid literal execution argv');
    runDeclaredExecution(JSON.parse(args[0]), args[1], { recheck });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
