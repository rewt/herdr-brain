// Closed, project-owned commands and coverage. No launch or runtime discovery.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { limitSeconds } from '../test-slot/limits.mjs';
import { validateGateDeclaration } from '../lib/gate-declaration.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';
import { RUNNER_ENVIRONMENT } from '../lanes/exact-validation.mjs';

export const DECLARED_SCHEMA = 'declared-gates/v2';
export const SELECTION_SCHEMA = 'promotion-gates/v1';
export const EXECUTION_SCHEMA = 'declared-gate-execution/v2';
export const RECEIPT_SCHEMA = 'declared-gate-receipt/v2';
export const ATTEMPT_SCHEMA = 'declared-gate-attempt/v2';
export const CAPABILITIES = Object.freeze({ declaration: DECLARED_SCHEMA, selection: SELECTION_SCHEMA, execution: EXECUTION_SCHEMA, receipt: RECEIPT_SCHEMA });
export const MAX_PLAN_BYTES = 1024 * 1024;
// Leave space for the executable, other argv and the environment on supported hosts.
export const MAX_EXECUTION_BYTES = 96 * 1024;
export const MAX_PATHS = 10000, MAX_BYTES = 64 * 1024 * 1024;
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const bytesHash = value => createHash('sha256').update(value).digest('hex');
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const refuse = reason => Object.assign(Error(`DECLARED_GATES_REFUSED: ${reason}`), { code: 'DECLARED_GATES_REFUSED' });
export const nonempty = value => typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0');
export const argv = value => Array.isArray(value) && value.length > 0 && nonempty(value[0]) && value.every(arg => typeof arg === 'string' && !arg.includes('\0'));
export function closed(value, keys, label) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw refuse(`invalid ${label} fields`);
}
export function relative(value, { dot = false } = {}) {
  return nonempty(value) && !value.includes('\\') && !path.isAbsolute(value) &&
    (dot && value === '.' || value !== '.' && path.posix.normalize(value) === value && !value.split('/').some(p => !p || p === '..' || p === '.'));
}
export function tokens(value, label) {
  if (!Array.isArray(value) || value.length > 512 || value.some(v => !nonempty(v)) || new Set(value).size !== value.length) throw refuse(`invalid ${label} tokens`);
  return value;
}
export function preparation(value = [], label = 'prepare') {
  if (!Array.isArray(value) || value.length > 512) throw refuse(`invalid ${label}`);
  for (const step of value) {
    closed(step, ['run', 'unless'], label);
    if (!nonempty(step.run) || step.unless !== undefined && !relative(step.unless)) throw refuse(`invalid ${label} step`);
    // A directory's presence is never a dependency-install witness. Avoid
    // classifying shell commands: all declared preparation runs on fresh attempts.
  }
  return value;
}
function inputs(value) {
  closed(value, ['paths', 'environment', 'toolchains'], 'inputs');
  if (value.paths !== undefined && (!Array.isArray(value.paths) || value.paths.length > 512 || value.paths.some(p => !relative(p, { dot: true })) || new Set(value.paths).size !== value.paths.length)) throw refuse('invalid input paths/globs');
  if (value.environment !== undefined && (!Array.isArray(value.environment) || value.environment.length > 512 || new Set(value.environment).size !== value.environment.length || value.environment.some(name =>
    typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RUNNER_ENVIRONMENT.includes(name) || /^HERDR_(PANE|TAB|WORKSPACE)_ID$/.test(name)))) throw refuse('invalid input environment allowlist');
  if (value.toolchains !== undefined && (!object(value.toolchains) || Object.keys(value.toolchains).length > 512 || Object.entries(value.toolchains).some(([name, probe]) => !nonempty(name) || !nonempty(probe)))) throw refuse('invalid declared toolchain probes');
}
export function validateDeclared(value) {
  closed(value, ['schema', 'fast', 'promotion', 'release', 'environment', 'timeout_seconds', 'idle_timeout_seconds', 'host_suites', 'tier_suites', 'gate', 'gates', 'coverage', 'promotion_tests', 'receipt_reuse', 'inputs'], 'declaration');
  if (value.schema !== DECLARED_SCHEMA) throw refuse(`unsupported declaration schema: ${value.schema}`);
  for (const tier of ['promotion', 'release']) if (!nonempty(value[tier])) throw refuse(`${tier} must be explicit and nonempty`);
  for (const key of ['fast', 'environment']) if (value[key] !== undefined && !nonempty(value[key])) throw refuse(`invalid ${key}`);
  if (!['always-execute', 'declared-inputs'].includes(value.receipt_reuse)) throw refuse('receipt_reuse must be explicit');
  closed(value.coverage, ['fast', 'promotion', 'release'], 'coverage');
  for (const tier of ['fast', 'promotion', 'release']) {
    if (value[tier] !== undefined) tokens(value.coverage[tier], `coverage.${tier}`);
    else if (value.coverage[tier] !== undefined) throw refuse(`coverage for undeclared tier ${tier}`);
  }
  for (const key of ['timeout_seconds', 'idle_timeout_seconds']) if (value[key] !== undefined) {
    const entries = object(value[key]) ? Object.entries(value[key]) : [[null, value[key]]];
    for (const [tier, seconds] of entries) {
      if (tier !== null && !['fast', 'promotion', 'release'].includes(tier)) throw refuse(`unknown watchdog tier: ${tier}`);
      limitSeconds(seconds, key, { idle: key === 'idle_timeout_seconds' });
    }
  }
  if (value.gate !== undefined) { validateGateDeclaration(value.gate); preparation(value.gate.prepare); }
  if (value.gates !== undefined && (!object(value.gates) || Object.keys(value.gates).length > 512)) throw refuse('invalid gates inventory');
  for (const [id, gate] of Object.entries(value.gates ?? {})) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) || ['fast', 'promotion', 'release'].includes(id)) throw refuse('invalid or colliding gate id');
    closed(gate, ['command', 'cwd', 'covers', 'inputs'], 'named gate');
    if (!nonempty(gate.command) || !relative(gate.cwd, { dot: true })) throw refuse('gate needs a complete command and project-relative cwd');
    tokens(gate.covers, `gate ${id} coverage`);
    if (gate.inputs !== undefined) inputs(gate.inputs);
  }
  if (value.inputs !== undefined) {
    closed(value.inputs, ['fast', 'promotion', 'release'], 'tier inputs');
    for (const [tier, spec] of Object.entries(value.inputs)) {
      if (value[tier] === undefined) throw refuse(`inputs for undeclared tier ${tier}`);
      inputs(spec);
    }
  }
  if (value.promotion_tests !== undefined) {
    closed(value.promotion_tests, ['command', 'prepare'], 'promotion_tests');
    if (!argv(value.promotion_tests.command)) throw refuse('promotion_tests.command must be literal argv');
    preparation(value.promotion_tests.prepare, 'promotion_tests.prepare');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PLAN_BYTES) throw refuse('declaration exceeds 1 MiB');
  return value;
}
export function readCommitted(root, name, base = 'HEAD', { schemaProbe = false, env = process.env } = {}) {
  const git = (args, input) => execFileSync('git', ['-C', root, ...args], { input, env, encoding: 'utf8', timeout: 20000, maxBuffer: MAX_PLAN_BYTES + 1024, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const objectName = `${base}:${name}`;
  const found = git(['cat-file', '--batch-check'], `${objectName}\n`).trim();
  if (found === `${objectName} missing`) return undefined;
  if (!/^[0-9a-f]+ blob [0-9]+$/.test(found)) throw refuse(`${name} must be a committed blob`);
  const entry = git(['ls-tree', base, '--', name]).trim();
  if (!/^100(?:644|755) blob /.test(entry)) {
    if (schemaProbe) return undefined;
    throw refuse(`${name} must be a regular committed file`);
  }
  const text = git(['show', objectName]);
  try { return parseUniqueJson(text); }
  catch (error) {
    if (schemaProbe && !/"schema"\s*:/.test(text)) return undefined;
    throw refuse(`invalid ${name}: ${error.message}`);
  }
}
export function snapshotDeclaration(owner) {
  const copy = structuredClone(owner);
  if (copy.environment_digests !== undefined || !copy.value.gate?.env) return copy;
  copy.environment_digests = Object.fromEntries(Object.entries(copy.value.gate.env).map(([name, value]) => [name, hash(value)]));
  copy.value.gate.env = Object.fromEntries(Object.entries(copy.environment_digests).map(([name, value]) => [name, `sha256:${value}`]));
  return copy;
}
export function sameDeclaration(bound, current) {
  if (!bound || !current || bound.schema !== DECLARED_SCHEMA || bound.selection_schema !== SELECTION_SCHEMA ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[0-9a-f]{64})$/.test(bound.source?.revision ?? '')) throw refuse('owner declaration missing; explicit disposition and re-admission required');
  validateDeclared(bound.value);
  const expected = snapshotDeclaration(current);
  expected.source.revision = bound.source.revision;
  if (hash(snapshotDeclaration(bound)) !== hash(expected)) throw refuse('owner declaration changed; explicit disposition and re-admission required');
}
export function gateDefinition(value, id) {
  if (['fast', 'promotion', 'release'].includes(id) && value[id] !== undefined) return { command: value[id], cwd: '.', covers: value.coverage[id], ...(value.inputs?.[id] ? { inputs: value.inputs[id] } : {}) };
  return value.gates && Object.hasOwn(value.gates, id) ? value.gates[id] : undefined;
}
