import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hash, refuse } from './declaration.mjs';
import { assertPythonFileLaunch } from './declared-policy.mjs';

function outsideLanes(file, forbiddenRoots) {
  for (const root of forbiddenRoots) {
    const offset = path.relative(fs.realpathSync(root), file);
    if (!offset || offset !== '..' && !offset.startsWith(`..${path.sep}`) && !path.isAbsolute(offset)) throw refuse(`planner tool resolves into a candidate or lane: ${file}`);
  }
  return file;
}
export function projectEnvironment(env, { candidate, snapshot, forbiddenRoots = candidate ? [candidate] : [] } = {}) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (/^(?:NODE_OPTIONS|NODE_PATH|NODE_TEST_CONTEXT|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE|PYTHONPYCACHEPREFIX|BASH_ENV|ENV|BASH_FUNC_.*|SHELLOPTS|BASHOPTS|ZDOTDIR|TS_NODE.*|TSX_.*|LD_.*|DYLD_.*|INIT_CWD|npm_(?:lifecycle_.*|config_node_options)|NPM_CONFIG_NODE_OPTIONS|GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*))$/.test(key)) delete result[key];
  if (snapshot) {
    const directories = [];
    for (const part of [path.join(snapshot, 'node_modules/.bin'), ...(result.PATH ?? '').split(path.delimiter)]) {
      if (!path.isAbsolute(part)) continue;
      let directory;
      try { directory = fs.realpathSync(part); } catch (error) { if (error.code === 'ENOENT') { directories.push(part); continue; } throw error; }
      outsideLanes(directory, forbiddenRoots);
      // Preparation is a shell recipe, so validate every executable it can
      // discover, including symlinks in otherwise external PATH directories.
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        let target;
        try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) target = fs.realpathSync(file); } catch { continue; }
        if (target) outsideLanes(target, forbiddenRoots);
      }
      directories.push(directory);
    }
    result.PATH = [...new Set(directories)].join(path.delimiter);
    result.PYTHONNOUSERSITE = '1';
  }
  result.PYTHONDONTWRITEBYTECODE = '1';
  return result;
}
export const remaining = deadline => {
  const ms = deadline - Date.now();
  if (ms <= 0) throw Object.assign(refuse('attempt wall-clock deadline exceeded'), { code: 'DECLARED_GATE_TIMEOUT' });
  return Math.max(1, Math.floor(ms));
};
function executable(name, cwd, env) {
  // Like spawn: slash-containing names bypass PATH; relative and empty PATH
  // entries are relative to the child's cwd. No implicit local bin directory.
  // Let the filesystem resolve symlinks before '..', as exec does.
  const fromCwd = file => path.isAbsolute(file) ? file : `${cwd}${path.sep}${file}`;
  const choices = name.includes('/') ? [fromCwd(name)] : (env.PATH ?? '/usr/bin:/bin').split(path.delimiter).map(dir => fromCwd(dir ? `${dir}${path.sep}${name}` : name));
  for (const file of choices) try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return fs.realpathSync.native(file); } catch {}
  throw refuse(`runtime executable is unavailable: ${name}`);
}
export function runtimeIdentity(command, { cwd, env, deadline, roots = [], forbiddenRoots = [] }) {
  assertPythonFileLaunch(command);
  const names = [command[0]];
  const exec = command.indexOf('exec');
  if (exec >= 0 && command[exec + 1] && !command[exec + 1].startsWith('-')) names.push(command[exec + 1]);
  const identify = (name, depth = 0) => {
    remaining(deadline);
    if (depth > 4) throw refuse('runtime interpreter chain exceeds four launchers');
    const file = outsideLanes(executable(name, cwd, env), forbiddenRoots), bytes = fs.readFileSync(file);
    if (depth === 0) assertPythonFileLaunch([file, ...command.slice(command.indexOf(name) + 1)]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const normalized = roots.reduce((value, [root, label]) => value.startsWith(root + path.sep) ? label + value.slice(root.length) : value, file);
    const shebang = bytes.subarray(0, 512).toString('utf8').match(/^#!([^\n]+)/)?.[1].trim();
    let version = `sha256:${digest}`, interpreter;
    if (shebang) {
      // A project driver may run tests even for --version. Never probe it.
      // Package metadata and the exact bytes identify scripts; inspect the
      // kernel's interpreter chain independently instead of executing them.
      for (let at = path.dirname(file), n = 0; n < 8; at = path.dirname(at), n++) {
        const metadata = path.join(at, 'package.json');
        if (fs.existsSync(metadata)) {
          const pkg = JSON.parse(fs.readFileSync(metadata, 'utf8'));
          if (pkg.name && pkg.version) version = `${pkg.name}@${pkg.version}`;
          break;
        }
        if (at === path.dirname(at)) break;
      }
      const words = shebang.split(/\s+/), binary = words[0] === '/usr/bin/env' ? words.slice(1).find(word => !word.startsWith('-') && !word.includes('=')) : words[0];
      assertPythonFileLaunch(words);
      if (!binary) throw refuse('unresolved runtime interpreter');
      interpreter = identify(binary, depth + 1).binding;
    } else if (file === fs.realpathSync(process.execPath)) version = process.version;
    else if (/^(?:node|python[0-9.]*(?:-config)?|bash|sh|zsh|ruby|perl|deno|bun)$/.test(path.basename(file))) {
      const result = spawnSync(file, ['--version'], { cwd, env, encoding: 'utf8', timeout: Math.min(3000, remaining(deadline)), maxBuffer: 65536, killSignal: 'SIGKILL' });
      if (result.error || result.status !== 0 || result.signal || !(result.stdout || result.stderr).trim()) throw refuse(`cannot identify runtime version: ${name}`);
      version = (result.stdout || result.stderr).trim();
    }
    return { name, executable: file, binding: { path: normalized, version, executable_sha256: digest, ...(interpreter ? { interpreter } : {}) } };
  };
  return names.map(name => identify(name));
}
export function runtimeBinding(facts) { return hash(facts.map(({ binding }) => binding)); }

// Shell strings with expansion, compound commands or indirect launchers cannot
// supply a complete runtime chain here. Refuse them before running the gate.
export function promotionRuntime(command, options) {
  if (/[\r\n]/.test(command)) throw refuse('mandatory command has unresolved shell runtime provenance');
  const words = [];
  let word = '', quote = null, active = false;
  for (const char of command.trim()) {
    if (quote && char === quote) { quote = null; continue; }
    if (char === "'" && quote !== '"' || char === '"' && quote !== "'") { quote = char; active = true; continue; }
    if (!quote && /\s/.test(char)) { if (active) words.push(word); word = ''; active = false; continue; }
    if (quote !== "'" && (quote === '"' ? /[$`\\]/ : /[^\w./:@%+=,-]/).test(char)) throw refuse('mandatory command has unresolved shell runtime provenance');
    word += char; active = true;
  }
  if (quote || !active && !words.length) throw refuse('mandatory command has unresolved shell runtime provenance');
  if (active) words.push(word);
  const name = path.basename(words[0]);
  const indirect = /^(?:(?:ba|da|z|k)?sh|env|exec|command|source|\.|npm|npx|pnpm|pnpx|yarn|corepack|uv|poetry|pipenv|time|nice|nohup|timeout|xargs)(?:\.[cm]?js)?$/;
  if (words[0].includes('=') || indirect.test(name) ||
      /^(?:node|bun)$/.test(name) && words.includes('--run')) throw refuse('mandatory command delegates unresolved runtime provenance');
  const runtime = runtimeIdentity(words, options);
  if (indirect.test(path.basename(runtime[0].executable)) || indirect.test(runtime[0].binding.version.split('@')[0])) throw refuse('mandatory command delegates unresolved runtime provenance');
  return [...runtimeIdentity(['/bin/sh'], options), ...runtime];
}

// Locked preparation identifies the artifact; hash the installed bytes too so
// an in-place dependency edit cannot reuse green evidence with the same version.
export function dependencyIdentity(root, deadline) {
  const directory = path.join(root, 'node_modules'), rows = [], versions = [];
  if (!fs.existsSync(directory)) return { digest: hash([]), versions };
  const walk = (at, relative = '') => {
    remaining(deadline);
    for (const name of fs.readdirSync(at).sort()) {
      const file = path.join(at, name), local = path.posix.join(relative, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(file), offset = path.relative(root, target);
        if (offset === '..' || offset.startsWith(`..${path.sep}`) || path.isAbsolute(offset)) throw refuse('prepared dependency symlink escapes the snapshot');
        rows.push([local, 'symlink', fs.readlinkSync(file)]);
      } else if (stat.isDirectory()) walk(file, local);
      else if (stat.isFile()) {
        rows.push([local, stat.mode & 0o777, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
        if (name === 'package.json') {
          const value = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (value.name && value.version) versions.push({ name: value.name, version: value.version });
        }
      } else throw refuse('prepared dependency is not a regular file');
    }
  };
  walk(directory);
  return { digest: hash(rows), versions };
}
