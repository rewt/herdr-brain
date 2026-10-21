// Conservative orchestration binding. Commands and their literal source
// closure, manifests, locks and runner configuration remain canonical. An
// adapter with dynamic orchestration that cannot be separated refuses.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, relative, refuse } from './declaration.mjs';

const git = (cwd, args, deadline) => {
  if (deadline !== undefined && Date.now() >= deadline) throw refuse('attempt deadline exceeded while binding orchestration');
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: Math.max(1, Math.min(20000, deadline === undefined ? Infinity : deadline - Date.now())), maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
};
const control = name => /(?:^|\/)(?:package\.json|[^/]*lock[^/]*|[^/]*\.lock|pyproject\.toml|requirements[^/]*\.txt|[^/]*config(?:\.[^/]+)?|\.[^/]*rc(?:\.[^/]+)?|\.nvmrc|\.npmrc|\.yarnrc(?:\.yml)?)$/.test(name);
export function policyBinding(repo, base, declaration, invocations = [], deadline) {
  const entries = git(repo, ['ls-tree', '-rz', base], deadline).split('\0').filter(Boolean).map(entry => {
    const at = entry.indexOf('\t'); return [entry.slice(at + 1), entry.slice(0, at)];
  });
  if (entries.length > 10000) throw refuse('canonical source exceeds 10000 paths');
  const tree = new Map(entries), seeds = new Set(entries.map(([name]) => name).filter(control));
  const definitions = [...Object.values(declaration.runners).flatMap(runner => runner.command.map(word => [word, runner.cwd])),
    ...invocations.flatMap(step => (step.args ?? []).map(word => [word, declaration.runners[step.runner].cwd])),
    [declaration.promotion, '.'], ...(declaration.gate?.prepare ?? []).map(step => [step.run, '.'])];
  const addWords = (text, cwd) => {
    for (const word of text.match(/[\w@./+-]+/g) ?? []) {
      for (const candidate of [word, path.posix.normalize(path.posix.join(cwd, word))]) {
        if (relative(candidate) && tree.has(candidate) && !/\.(?:test|spec)\.[^/]+$/.test(candidate)) seeds.add(candidate);
      }
    }
  };
  for (const [word, cwd] of definitions) addWords(word, cwd);
  const inspected = new Set();
  let python = false;
  for (const name of seeds) {
    if (inspected.has(name)) continue;
    const entry = tree.get(name);
    if (!/^100(?:644|755) blob /.test(entry)) throw refuse(`orchestration must be a regular canonical source: ${name}`);
    const text = git(repo, ['show', `${base}:${name}`], deadline);
    if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw refuse('canonical source exceeds 64 MiB');
    // Dynamic source loaders cannot prove which policy they will execute.
    if (/\b(?:import|require)\s*\(\s*[^'"\s]/.test(text)) throw refuse(`dynamic orchestration cannot be separated: ${name}`);
    if (name.endsWith('.py') || /^#![^\n]*\bpython[\d.]*/.test(text)) {
      python = true;
      // Bind a conservative superset of the local import closure, including
      // packages and transitive helpers. Never infer Python imports from JS
      // string-literal syntax. Dynamic loaders need a richer adapter.
      if (/\b(?:__import__|exec|eval|compile)\s*\(|\bimportlib\b|\bsys\s*\.\s*path\b/.test(text)) throw refuse(`dynamic Python orchestration cannot be separated: ${name}`);
      for (const candidate of tree.keys()) if (candidate.endsWith('.py')) seeds.add(candidate);
    }
    inspected.add(name);
    if (path.posix.basename(name) === 'package.json') {
      for (const script of Object.values(JSON.parse(text).scripts ?? {})) addWords(script, path.posix.dirname(name));
    } else {
      for (const match of text.matchAll(/['"]([^'"\n]+\.(?:[cm]?js|[cm]?ts|py|sh|json|ya?ml))['"]/g)) addWords(match[1], path.posix.dirname(name));
    }
    // Resolve extensionless literal imports without assuming a runner language.
    for (const match of text.matchAll(/['"](\.{1,2}\/[^'"\n]+)['"]/g)) {
      const prefix = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      for (const candidate of tree.keys()) if (candidate.startsWith(prefix + '.') || candidate.startsWith(prefix + '/index.')) seeds.add(candidate);
    }
  }
  const scope = [...inspected].sort().map(name => [name, tree.get(name)]);
  const toolchain = entries.filter(([name]) => control(name)).sort(([a], [b]) => a.localeCompare(b));
  return { scope: hash(scope), toolchain: hash({ runners: declaration.runners, gate: declaration.gate ?? {}, environment: declaration.environment ?? '', files: toolchain }), files: scope, python };
}
export function assertCandidatePolicy(repo, candidate, binding, deadline) {
  const controls = git(repo, ['ls-tree', '-rz', candidate], deadline).split('\0').filter(Boolean).map(entry => entry.slice(entry.indexOf('\t') + 1)).filter(name => control(name) || binding.python && /\.(?:py|pyc|pyd|so)$/.test(name));
  if (controls.some(name => !binding.files.some(([file]) => file === name))) throw refuse('candidate adds uncaptured orchestration configuration');
  for (const [name, expected] of binding.files) {
    const entry = git(repo, ['ls-tree', candidate, '--', name], deadline).trim().split('\t')[0];
    if (entry !== expected) throw refuse(`candidate changes canonical orchestration: ${name}`);
  }
}
export function within(root, relativePath) {
  const target = path.resolve(root, relativePath), offset = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  if (offset === '..' || offset.startsWith(`..${path.sep}`) || path.isAbsolute(offset)) throw refuse('source or runner cwd escapes its snapshot');
  return target;
}

export function assertRunnerPolicy(root, declaration, steps, binding) {
  const canonical = new Set(binding.files.map(([name]) => name));
  if (binding.python) {
    const inspect = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['.git', 'node_modules'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name), name = path.relative(root, file);
        if (entry.isSymbolicLink()) throw refuse(`uncaptured Python import symlink: ${name}`);
        if (entry.isDirectory()) inspect(file);
        else if (/\.(?:py|pyc|pyd|so)$/.test(name) && !canonical.has(name)) throw refuse(`uncaptured generated Python import: ${name}`);
      }
    };
    inspect(root);
  }
  const commands = [...Object.values(declaration.runners).map(runner => [runner.cwd, runner.command]),
    ...steps.map(step => [declaration.runners[step.runner].cwd, step.args])];
  for (const [cwd, words] of commands) for (const word of words) {
    if (word.startsWith('-') || /\.(?:test|spec)\.[^/]+$/.test(word)) continue;
    const file = path.resolve(root, cwd, word), name = path.relative(root, file);
    if (name.startsWith('..') || path.isAbsolute(name) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    // Installed executables/libraries are independently hashed against the
    // locked preparation. Generated project orchestration has no canonical
    // source binding, so an adapter cannot certify it as a bound invocation.
    if (name.split(path.sep).includes('node_modules')) continue;
    const source = /\.(?:[cm]?js|[cm]?ts|py|sh)$/.test(name) || fs.readFileSync(file).subarray(0, 2).toString() === '#!';
    if (source && !canonical.has(name)) throw refuse(`uncaptured generated runner orchestration: ${name}`);
  }
}
