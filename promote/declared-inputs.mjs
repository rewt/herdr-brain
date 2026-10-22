// Only the project's explicit inputs/probes participate. No inferred closure,
// executable search, runtime chain, package expansion or runner-owned scope.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RUNNER_ENVIRONMENT, restrictEnvironment } from '../lanes/exact-validation.mjs';
import { hash, bytesHash, MAX_PATHS, MAX_BYTES } from './declaration.mjs';
import { remaining, contained } from './declared-support.mjs';

export function inputEligibility(inputs, literal = {}) {
  if (!inputs || !Array.isArray(inputs.paths) || !inputs.paths.length) return 'inputs.paths missing';
  if (!Array.isArray(inputs.environment)) return 'inputs.environment missing';
  if (Object.keys(literal).some(name => !inputs.environment.includes(name))) return 'literal environment is outside allowlist';
  // Tool names and commands are project assertions. Require separate runtime
  // and runner observations; when one tool serves both, declare its probe twice
  // under the two role names. Never classify a gate command to guess either.
  if (!inputs.toolchains || Object.keys(inputs.toolchains).length < 2) return 'runtime and runner toolchain observations missing';
  return null;
}
export const gateEnvironment = (env, inputs) => restrictEnvironment(env, { environment: inputs.environment });
export function preparationEnvironment(value, definitions, env) {
  if (!(value.gate?.prepare ?? []).length) return { env, reusable: true };
  const eligible = definitions.filter(def => value.receipt_reuse === 'declared-inputs' && !inputEligibility(def.inputs, value.gate?.env));
  if (!eligible.length) return { env, reusable: false };
  const first = gateEnvironment(env, eligible[0].inputs);
  const same = eligible.every(def => hash(gateEnvironment(env, def.inputs)) === hash(first));
  return { env: same ? first : env, reusable: same };
}

// Standard *, ** and ? path globs; unsupported syntax is a conservative miss.
// Walk only the literal prefix, including ignored/generated paths when declared.
function patternRegex(pattern) {
  if (/[\[\]{}\\]/.test(pattern)) throw Error('unrepresentable input glob');
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { out += '(?:.*/)?'; i++; } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}
export function observePaths(root, specs, deadline) {
  root = fs.realpathSync(root);
  const entries = new Map(), memberships = [];
  let visited = 0, total = 0;
  const count = () => { remaining(deadline); if (++visited > MAX_PATHS) throw Error('input enumeration exceeds 10000 paths'); };
  const put = (name, stat) => {
    if (entries.has(name)) return;
    if (name === '.git' || name.startsWith('.git/')) throw Error('Git storage is not a representable gate input');
    const target = path.join(root, name);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(target), resolved = contained(root, name);
      total += Buffer.byteLength(link);
      const dest = fs.statSync(resolved);
      if (dest.isFile()) {
        total += dest.size;
        if (total > MAX_BYTES) throw Error('input hashing exceeds 64 MiB');
        entries.set(name, ['symlink-file', mode, link, dest.mode & 0o777, bytesHash(fs.readFileSync(resolved))]);
      } else if (dest.isDirectory()) entries.set(name, ['symlink-directory', mode, link, dest.mode & 0o777]);
      else throw Error('unrepresentable symlink input');
    } else if (stat.isFile()) {
      total += stat.size;
      if (total > MAX_BYTES) throw Error('input hashing exceeds 64 MiB');
      // Bound allocation before reading and reject a file that grows mid-read.
      const fd = fs.openSync(target, 'r');
      try {
        const h = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        let read = 0, n;
        while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
          remaining(deadline); read += n;
          if (read > stat.size || total > MAX_BYTES) throw Error('unstable input size');
          h.update(buffer.subarray(0, n));
        }
        if (read !== stat.size) throw Error('unstable input size');
        entries.set(name, ['file', mode, h.digest('hex')]);
      } finally { fs.closeSync(fd); }
    } else if (stat.isDirectory()) entries.set(name, ['directory', mode]);
    else throw Error('unrepresentable input entry');
    if (total > MAX_BYTES) throw Error('input hashing exceeds 64 MiB');
  };
  for (const spec of specs) {
    remaining(deadline);
    const glob = /[*?\[\]{}]/.test(spec), regex = glob ? patternRegex(spec) : null;
    const parts = spec.split('/'), prefix = glob ? parts.slice(0, parts.findIndex(p => /[*?\[\]{}]/.test(p))).join('/') : spec;
    const matched = [];
    const walk = (name, ancestors = new Set()) => {
      count();
      if (name === '.git' || name.startsWith('.git/')) { if (regex?.test(name) || !glob) throw Error('Git storage is not an input'); return; }
      const target = path.join(root, name);
      let stat;
      try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      // Resolve every traversed component, including literal paths with a
      // symlink in an ancestor, before reading any bytes.
      contained(root, name || '.');
      if (!glob || regex.test(name) || spec.endsWith('/**') && name === spec.slice(0, -3)) {
        put(name || '.', stat); matched.push(name || '.');
      }
      const real = fs.realpathSync(target);
      if (stat.isDirectory() || stat.isSymbolicLink() && fs.statSync(real).isDirectory()) {
        if (ancestors.has(real)) throw Error('cyclic input symlink');
        const next = new Set(ancestors).add(real), dir = fs.opendirSync(target);
        try {
          let entry;
          while ((entry = dir.readSync())) walk(name ? `${name}/${entry.name}` : entry.name, next);
        } finally { dir.closeSync(); }
      }
    };
    walk(prefix === '.' ? '' : prefix);
    memberships.push([spec, matched.sort()]);
  }
  remaining(deadline);
  return { digest: hash({ entries: [...entries].sort(([a], [b]) => a.localeCompare(b)), memberships }), paths: entries.size, bytes: total };
}
export function observation({ root, definition, declaration, identity, env, probes, deadline, limits }) {
  try {
    const paths = observePaths(root, definition.inputs.paths, deadline);
    const environment = Object.fromEntries(definition.inputs.environment.slice().sort().map(name => [name,
      env[name] === undefined ? { present: false } : { present: true, digest: bytesHash(String(env[name])) }]));
    const policy = { definition, prepare: declaration.gate?.prepare ?? [], environment: declaration.environment ?? '',
      gate: { ...declaration.gate, env: Object.fromEntries(Object.entries(declaration.gate?.env ?? {}).map(([k, v]) => [k, hash(v)])) },
      timeout_seconds: declaration.timeout_seconds ?? null, idle_timeout_seconds: declaration.idle_timeout_seconds ?? null,
      receipt_reuse: declaration.receipt_reuse, limits };
    const toolchains = Object.fromEntries(Object.entries(probes).sort(([a], [b]) => a.localeCompare(b)).map(([name, probe]) => [name, { command: probe.command, output_digest: probe.output_digest }]));
    const observed = { project: identity.common, caller_root: identity.caller_root, project_root: identity.project_root,
      policy: hash(policy), paths: paths.digest, environment: hash(environment), toolchains: hash(toolchains) };
    return { key: hash(observed), digests: observed, inventory: { paths: paths.paths, bytes: paths.bytes }, environment, toolchains };
  } catch (error) {
    if (error.code === 'DECLARED_GATE_TIMEOUT') throw error;
    return { miss: `input evidence unavailable: ${error.message}` };
  }
}
export function missDimension(before, after) {
  for (const key of ['project', 'caller_root', 'project_root', 'policy', 'paths', 'environment', 'toolchains']) if (before?.digests?.[key] !== after?.digests?.[key]) return key;
  return null;
}
export { RUNNER_ENVIRONMENT };
