// Release selection is project configuration, never inherited run metadata.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { gitProject } from './project.mjs';

export const PIN_FILE = '.herdr-release.json';
export const releaseHome = () => path.join(os.userInfo().homedir, '.local/share/herdr-monitor');
// Git's inherited repository/index/config selectors must not choose the project.
export const projectEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
  env: projectEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
}).trim();
export function releaseProject(cwd) { return gitProject(cwd, { env: projectEnvironment(), timeoutMs: 10000 }); }

export function projectPin(cwd) {
  // A non-repository retains the historical global launcher behaviour. An
  // identified repository with broken canonical metadata must fail closed.
  try { git(cwd, ['rev-parse', '--show-toplevel']); }
  catch (error) {
    if (/not a git repository/.test(String(error.stderr))) return null;
    throw error;
  }
  const project = releaseProject(cwd);
  let head;
  try { head = git(project.canonical, ['rev-parse', '--verify', 'HEAD']); }
  catch (error) {
    const ref = git(project.canonical, ['symbolic-ref', 'HEAD']);
    const result = spawnSync('git', ['-C', project.canonical, 'show-ref', '--verify', '--quiet', ref], { env: projectEnvironment() });
    if (result.status === 1) return { project, release: null };
    throw error;
  }
  const entry = git(project.canonical, ['ls-tree', head, '--', PIN_FILE]);
  if (!entry) return { project, release: null };
  if (!/^100644 blob |^100755 blob /.test(entry)) throw Error(`${PIN_FILE} must be a committed regular file`);
  const config = JSON.parse(git(project.canonical, ['show', `${head}:${PIN_FILE}`]));
  if (!config || Array.isArray(config) || typeof config !== 'object' ||
      Object.keys(config).some(key => key !== 'release') || !Object.hasOwn(config, 'release')) throw Error(`invalid ${PIN_FILE}`);
  if (config.release !== null) validReleaseId(config.release);
  return { project, release: config.release, config_commit: head };
}

export function validReleaseId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id.endsWith('.partial')) throw Error(`invalid release identifier: ${id}`);
  return id;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const mandatory = ['bin/org.mjs', 'lanes/lane.mjs', 'lib/releases.mjs', 'supervisor/supervisor.mjs',
  'promote/promote.mjs', 'housekeeping/housekeeping.mjs', 'contrib/settle-watch.mjs', 'lib/cli-help.mjs'];

// Admission checks only headers and required entries. Build and pin explicitly
// request the full inventory verification, keeping payload reads off the hot path.
export function checkBundle(root, { verifyFiles = false } = {}) {
  root = fs.realpathSync(root);
  const id = path.basename(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.release-manifest.json'), 'utf8'));
  const commit = fs.readFileSync(path.join(root, '.release-commit'), 'utf8').trim();
  if (manifest.schema !== 'herdr-release/v1' || manifest.protocol !== 1 || manifest.commit !== commit ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) || !manifest.files || mandatory.some(file => !manifest.files[file])) throw Error(`incomplete or incompatible release: ${id}`);
  for (const file of mandatory) {
    if (!fs.lstatSync(path.join(root, file)).isFile() || fs.realpathSync(path.join(root, file)) !== path.join(root, file)) throw Error(`incomplete release ${id}: ${file}`);
  }
  if (verifyFiles) for (const [file, hash] of Object.entries(manifest.files)) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).some(part => !part || part === '..' || part === '.') ||
        !fs.lstatSync(path.join(root, file)).isFile() || fs.realpathSync(path.join(root, file)) !== path.join(root, file) ||
        sha(fs.readFileSync(path.join(root, file))) !== hash) throw Error(`incomplete release ${id}: ${file}`);
  }
  return { root, id, commit, protocol: 1 };
}

export function checkRelease(home, id, options) {
  validReleaseId(id);
  const releases = fs.realpathSync(path.join(home, 'releases'));
  const root = path.join(releases, id);
  if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw Error(`release is not an immutable directory: ${id}`);
  return checkBundle(root, options);
}

export function selectRelease(cwd = process.cwd(), home = releaseHome(), { fallbackRoot } = {}) {
  const pin = projectPin(cwd);
  if (pin?.release) return { ...checkRelease(home, pin.release), selection: 'project', identity: pin.project.identity, config_commit: pin.config_commit };
  // Legacy unpinned releases need no new manifest. Resolve current exactly once.
  const root = fs.realpathSync(fallbackRoot ?? path.join(home, 'current'));
  return { ...bundleRelease(root), selection: fallbackRoot ? 'bundle' : 'current', ...(pin ? { identity: pin.project.identity } : {}) };
}

// Evidence describes the executing bundle, not a second read of a mutable pin.
export function bundleRelease(root = fileURLToPath(new URL('../', import.meta.url))) {
  root = fs.realpathSync(root);
  let commit = null;
  try { commit = fs.readFileSync(path.join(root, '.release-commit'), 'utf8').trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { root, id: commit ? path.basename(root) : null, commit, protocol: 1 };
}

export function runRelease(relative, args, { cwd = process.cwd(), home = releaseHome(), fallbackRoot } = {}) {
  if (path.isAbsolute(relative) || !/^[\w./-]+\.mjs$/.test(relative) || relative.split('/').includes('..')) throw Error('expected a bundle-relative .mjs entry point');
  const option = ['supervisor/supervisor.mjs', 'promote/promote.mjs', 'dispatch/dispatch.mjs', 'settle/settle.mjs'].includes(relative)
    ? '--repo' : ['housekeeping/housekeeping.mjs', 'watch/watch.mjs'].includes(relative) ? '--cwd' : null;
  let projectCwd = cwd;
  if (option) {
    // Match the entry's explicit project option, without interpreting any
    // other command data. Execution keeps the caller's cwd and exact argv.
    for (let index = 0; index < args.length && args[index] !== '--'; index++) {
      if (args[index] === option && args[index + 1]) projectCwd = path.resolve(cwd, args[++index]);
      else if (args[index].startsWith(`${option}=`)) projectCwd = path.resolve(cwd, args[index].slice(option.length + 1));
    }
  }
  const release = selectRelease(projectCwd, home, { fallbackRoot });
  const result = spawnSync(process.execPath, [path.join(release.root, relative), ...args], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Explicit immutable bundle paths are also the continuation protocol. Source
// and mutable-current entry points consult the project; children use real paths.
export function forwardRelease(relative, cwd) {
  const actual = bundleRelease();
  const invoked = process.argv[1] && path.resolve(process.argv[1]);
  if (actual.commit && invoked === path.join(actual.root, relative)) return null;
  const pin = projectPin(cwd);
  if (!pin?.release) return null;
  if (!actual.commit) {
    // A project's own checkout and lanes are development entry points. Other
    // projects' source bundles still route through the target project's pin.
    let identity;
    try { identity = fs.realpathSync(git(actual.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])); }
    catch (error) { if (!/not a git repository/.test(String(error.stderr))) throw error; }
    if (identity === pin.project.identity) return null;
  }
  const home = actual.commit ? path.dirname(path.dirname(actual.root)) : releaseHome();
  const selected = checkRelease(home, pin.release);
  if (selected.root === actual.root) return null;
  const result = spawnSync(process.execPath, [path.join(selected.root, relative), ...process.argv.slice(2)], { cwd: process.cwd(), stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function continueRelease(relative, release) {
  if (!release || release.root === bundleRelease().root) return null;
  const result = spawnSync(process.execPath, [operationFile(relative, release), ...process.argv.slice(2)], { cwd: process.cwd(), stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function operationFile(relative, release) {
  if (!release || release.protocol !== 1 || !path.isAbsolute(release.root)) throw Error('incompatible operation release protocol; inspect its receipt');
  const actual = bundleRelease(release.root);
  if (actual.root !== release.root || actual.id !== release.id || actual.commit !== release.commit) throw Error('operation release identity changed; inspect its receipt');
  return path.join(actual.root, relative);
}
