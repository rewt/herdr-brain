// Opt-in, engineer-attested exact-input evidence. No ambient environment values
// are persisted. The canonical base alone selects this execution contract.
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const RECEIPTS_FILE = '.validation-receipts.json';
export const EXACT_SCHEMA = 'exact-validation/v1';
export const exactDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = (cwd, args, input) => execFileSync('git', ['-C', cwd, ...args], { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// This is a closed set, not a prefix wildcard. These are the runner-owned
// MONITOR_*/BCH_CLOAK_TEST_SLOT_* exclusions in validation.mjs at ad97e531.
export const RUNNER_ENVIRONMENT = Object.freeze([
  'MONITOR_VALIDATION_TIER', 'MONITOR_VALIDATION_DEADLINE', 'MONITOR_TEST_SLOT_PATH',
  'MONITOR_TEST_SLOT_COMPAT_PATH', 'MONITOR_TEST_SLOT_TOKEN', 'MONITOR_TEST_SLOT_OCCUPANCY_PATH',
  'MONITOR_TEST_SLOT_WAIT_SECONDS', 'MONITOR_TEST_SLOT_TIMEOUT_RETRIED',
  'BCH_CLOAK_TEST_SLOT_TOKEN', 'BCH_CLOAK_TEST_SLOT_WAIT_SECONDS',
]);
export const EXACT_EXCLUSIONS = Object.freeze(['settle-review-document', 'runner-owned-environment']);
const review = /^docs\/reviews\/[a-z0-9][a-z0-9-]*\/[0-9a-f]{7}-r[1-9][0-9]*\.md$/;

export function validateReceiptDeclaration(value) {
  if (!object(value) || Object.keys(value).some(key => !['schema', 'exclude', 'environment'].includes(key))) throw Error('invalid validation receipts declaration keys');
  if (value.schema !== 'validation-receipts/v1') throw Error('unknown validation receipts schema');
  if (!Array.isArray(value.exclude) || new Set(value.exclude).size !== value.exclude.length || value.exclude.some(id => id !== 'settle-review-document')) throw Error('unknown validation receipts exclusion');
  if (!Array.isArray(value.environment) || new Set(value.environment).size !== value.environment.length || value.environment.some(name =>
    typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RUNNER_ENVIRONMENT.includes(name) || /^HERDR_(PANE|TAB|WORKSPACE)_ID$/.test(name))) throw Error('invalid validation receipts environment allowlist');
  return { schema: value.schema, exclude: [...value.exclude].sort(), environment: [...value.environment].sort() };
}

export function readReceiptDeclaration({ repo, base }) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) throw Error('validation receipts require a full canonical base commit');
  // Batch-check distinguishes an absent path from a Git failure without
  // touching legacy settings-reader ls-tree/show calls for unconfigured repos.
  const objectName = `${base}:${RECEIPTS_FILE}`;
  const found = git(repo, ['cat-file', '--batch-check'], `${objectName}\n`).trim();
  if (found === `${objectName} missing`) return null;
  if (!/^[0-9a-f]+ blob [0-9]+$/.test(found)) throw Error('validation receipts declaration must be a blob');
  const entry = git(repo, ['ls-tree', base, '--', RECEIPTS_FILE]).trim();
  if (!/^100644 blob /.test(entry)) throw Error('validation receipts declaration must be a regular 100644 file');
  return validateReceiptDeclaration(JSON.parse(git(repo, ['show', `${base}:${RECEIPTS_FILE}`])));
}

export function restrictEnvironment(env, declaration) {
  const names = new Set([...declaration.environment, ...RUNNER_ENVIRONMENT]);
  return Object.fromEntries([...names].sort().filter(name => Object.hasOwn(env, name) && env[name] !== undefined).map(name => [name, String(env[name])]));
}

function treeEntries(repo, ref) {
  return new Map(git(repo, ['ls-tree', '-rz', ref]).split('\0').filter(Boolean).map(entry => {
    const split = entry.indexOf('\t');
    return [entry.slice(split + 1), entry.slice(0, split)];
  }));
}
const allowedAddition = (name, entry, declaration) => declaration.exclude.includes('settle-review-document') && review.test(name) && /^100644 blob /.test(entry);

export function excludedAdditions({ repo, base, head, declaration }) {
  const before = treeEntries(repo, base), after = treeEntries(repo, head);
  return [...after].filter(([name, entry]) => !before.has(name) && allowedAddition(name, entry, declaration)).map(([name]) => name).sort();
}

// null is an ineligible delta; [] is an identical tree. Modifications, deletes,
// mode changes and renames can never masquerade as a permitted addition.
export function excludedDelta({ repo, from, to, declaration }) {
  const before = treeEntries(repo, from), after = treeEntries(repo, to), excluded = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(name) === after.get(name)) continue;
    if (before.has(name) || !after.has(name) || !allowedAddition(name, after.get(name), declaration)) return null;
    excluded.push(name);
  }
  return excluded.sort();
}

export function exactIdentity({ cwd, common, base, commands, prepare = [], environment = '', env = process.env, declaration, toolchain, additional = {} }) {
  declaration = validateReceiptDeclaration(declaration);
  if (!Array.isArray(commands) || !commands.length || commands.some(command => typeof command !== 'string' || !command.trim())) throw Error('exact validation requires ordered commands');
  const fullBase = git(cwd, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  if (fullBase !== base) throw Error('exact validation requires a full base commit');
  git(cwd, ['merge-base', '--is-ancestor', base, 'HEAD']);
  const repo = fs.realpathSync(common);
  if (fs.realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) !== repo) throw Error('exact validation Git common-directory identity changed');
  const entries = treeEntries(cwd, 'HEAD'), excluded = new Set(excludedAdditions({ repo: cwd, base, head: 'HEAD', declaration }));
  const restricted = restrictEnvironment(env, declaration);
  toolchain ??= { node: { path: fs.realpathSync(process.execPath), version: process.version },
    git: execFileSync('git', ['--version'], { env: restricted, encoding: 'utf8' }).trim(),
    shell: '/bin/sh', platform: process.platform, arch: process.arch, release: os.release() };
  if (!object(toolchain) || !object(toolchain.node) || ['path', 'version'].some(key => typeof toolchain.node[key] !== 'string' || !toolchain.node[key]) ||
      ['git', 'shell', 'platform', 'arch', 'release'].some(key => typeof toolchain[key] !== 'string' || !toolchain[key])) throw Error('exact toolchain must retain every core field');
  const identity = {
    schema: EXACT_SCHEMA, repo, base,
    candidate: exactDigest([...entries].filter(([name]) => !excluded.has(name))),
    commands: [...commands],
    toolchain,
    environment: Object.fromEntries(declaration.environment.map(name => [name, Object.hasOwn(restricted, name) ? sha256(restricted[name]) : 'absent'])),
    prepare, declared: environment,
    exclusions: { named: [...EXACT_EXCLUSIONS], enabled: [...declaration.exclude], environment: [...RUNNER_ENVIRONMENT] },
  };
  if (!object(additional) || Object.keys(additional).some(key => Object.hasOwn(identity, key) || additional[key] === undefined)) throw Error('exact adapter inputs cannot replace or remove core fields');
  for (const key of Object.keys(additional).sort()) Object.defineProperty(identity, key, { value: additional[key], enumerable: true });
  return identity;
}

export function explainMiss(current, receipt) {
  const previous = receipt?.exact?.identity ?? receipt;
  const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
  for (const field of ['repo', 'base', 'candidate', 'commands']) if (differs(current[field], previous?.[field])) return field;
  for (const field of new Set(['node', 'git', 'shell', 'platform', 'arch', 'release', ...new Set([...Object.keys(current.toolchain), ...Object.keys(previous?.toolchain ?? {})].sort())])) {
    if (differs(current.toolchain[field], previous?.toolchain?.[field])) return `toolchain.${field}`;
  }
  for (const name of [...new Set([...Object.keys(current.environment), ...Object.keys(previous?.environment ?? {})])].sort()) {
    if (differs(current.environment[name], previous?.environment?.[name])) return `environment.${name}`;
  }
  for (const field of ['prepare', 'declared']) if (differs(current[field], previous?.[field])) return field;
  if (differs(current.exclusions, previous?.exclusions)) return 'declared';
  // Adapter additions are bound too. Core fields cannot be removed by adapters.
  for (const field of [...new Set([...Object.keys(current), ...Object.keys(previous ?? {})])].sort()) {
    if (differs(current[field], previous?.[field])) return 'declared';
  }
  return null;
}

export function requireExactPlan(validation, plan) {
  let reason;
  if (validation.tiers.promotion.source === 'env') reason = 'promotion command source is env';
  else if (!validation.promotion_tests || !plan) reason = 'promotion_tests planner is undeclared';
  else if (plan.unknown?.length) reason = `unknown selection: ${plan.unknown.join(', ')}`;
  if (reason) throw selectionUnknown(reason);
}
export const selectionUnknown = reason => Object.assign(new Error(`SELECTION_UNKNOWN: ${reason}`), { code: 'SELECTION_UNKNOWN' });
