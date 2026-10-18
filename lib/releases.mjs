// Release selection is project configuration, never inherited run metadata.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { gitProject } from './project.mjs';

export const PIN_FILE = '.herdr-release.json';
export const releaseHome = () => path.join(os.userInfo().homedir, '.local/share/herdr-monitor');
// Git's inherited repository/index/config selectors must not choose the project.
export const projectEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
  env: projectEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
}).trim();
export function releaseProject(cwd) { return gitProject(cwd, { env: projectEnvironment(), timeoutMs: 10000 }); }

// Prove absence only for ordinary Git layouts and verified loose objects. A
// packed object, unusual config, or unreadable metadata is uncertainty, never
// evidence that a pin is absent: the normal Git-verified path handles it.
function pinPrecheck(cwd) {
  try {
    const stat = file => fs.statSync(file, { throwIfNoEntry: false });
    const text = file => {
      if (fs.statSync(file).size > 1024 * 1024) throw Error('metadata exceeds precheck bound');
      return fs.readFileSync(file, 'utf8').trim();
    };
    const markerDirectory = file => {
      if (stat(file)?.isDirectory()) return fs.realpathSync(file);
      const match = /^gitdir: ([^\r\n]+)$/.exec(text(file));
      if (!match) throw Error('unknown Git marker');
      return fs.realpathSync(path.resolve(path.dirname(file), match[1]));
    };
    let checkout = fs.realpathSync(cwd ?? process.cwd());
    if (!stat(checkout)?.isDirectory()) return undefined;
    for (;;) {
      if (fs.lstatSync(path.join(checkout, '.git'), { throwIfNoEntry: false })) break;
      // Bare repositories and calls inside Git metadata retain Git's refusal.
      if (stat(path.join(checkout, 'HEAD')) && stat(path.join(checkout, 'objects'))) return undefined;
      const parent = path.dirname(checkout);
      if (parent === checkout) return null;
      checkout = parent;
    }
    const directory = markerDirectory(path.join(checkout, '.git'));
    const commonFile = path.join(directory, 'commondir');
    const identity = stat(commonFile) ? fs.realpathSync(path.resolve(directory, text(commonFile))) : directory;
    if (path.basename(identity) !== '.git') return undefined;
    const canonical = fs.realpathSync(path.dirname(identity));
    if (markerDirectory(path.join(canonical, '.git')) !== identity) return undefined;
    const config = text(path.join(identity, 'config'));
    if (/^\s*\[\s*(?:include|includeIf|extensions)\b/im.test(config) || /^\s*worktree\s*=/im.test(config) ||
        !/^\s*bare\s*=\s*false\s*$/im.test(config) ||
        [...config.matchAll(/^\s*bare\s*=\s*(.*)$/gim)].some(match => match[1].trim().toLowerCase() !== 'false') ||
        stat(path.join(identity, 'config.worktree')) || stat(path.join(identity, 'info/grafts'))) return undefined;
    const project = { checkout, canonical, identity };
    if (fs.lstatSync(path.join(canonical, PIN_FILE), { throwIfNoEntry: false })) return undefined;
    const packedFile = path.join(identity, 'packed-refs');
    const packed = stat(packedFile) ? text(packedFile) : '';
    if (packed.split('\n').some(line => line && !line.startsWith('#') &&
        !/^(?:[0-9a-f]{40} refs\/[^\s]+|\^[0-9a-f]{40})$/.test(line))) return undefined;
    if (/ refs\/replace\//m.test(packed) ||
        (stat(path.join(identity, 'refs/replace')) && fs.readdirSync(path.join(identity, 'refs/replace')).length)) return undefined;
    let head = text(path.join(identity, 'HEAD'));
    const seen = new Set();
    while (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      if (!/^refs\/[\w./-]+$/.test(ref) || ref.split('/').some(part => !part || part === '.' || part === '..') || seen.has(ref) || seen.size >= 8) return undefined;
      seen.add(ref);
      const file = path.join(identity, ref);
      if (stat(file)) head = text(file);
      else {
        const row = packed.split('\n').find(line => line.endsWith(` ${ref}`));
        if (!row) return { project, release: null }; // An unborn canonical branch.
        head = row.split(' ')[0];
      }
    }
    if (!/^[0-9a-f]{40}$/.test(head)) return undefined;
    const stores = [path.join(identity, 'objects')], visited = new Set();
    const object = (id, type) => {
      for (let index = 0; index < stores.length && index < 16; index++) {
        const store = fs.realpathSync(stores[index]);
        if (visited.has(store)) continue;
        visited.add(store);
        const file = path.join(store, id.slice(0, 2), id.slice(2));
        if (stat(file)) {
          if (fs.statSync(file).size > 8 * 1024 * 1024) return null;
          const bytes = inflateSync(fs.readFileSync(file), { maxOutputLength: 8 * 1024 * 1024 });
          const end = bytes.indexOf(0), header = bytes.subarray(0, end).toString();
          const body = bytes.subarray(end + 1);
          if (end < 0 || header !== `${type} ${body.length}` || createHash('sha1').update(bytes).digest('hex') !== id) return null;
          return body;
        }
        const alternatives = path.join(store, 'info/alternates');
        if (stat(alternatives)) for (const line of text(alternatives).split('\n').filter(Boolean)) stores.push(path.resolve(store, line));
      }
      return null;
    };
    const commit = object(head, 'commit');
    if (!commit) return undefined;
    const treeId = /^tree ([0-9a-f]{40})\n/.exec(commit.toString())?.[1];
    if (!treeId) return undefined;
    visited.clear();
    const tree = object(treeId, 'tree');
    if (!tree) return undefined;
    for (let offset = 0; offset < tree.length;) {
      const space = tree.indexOf(32, offset), end = tree.indexOf(0, space + 1);
      if (space < offset || end < space || end + 21 > tree.length ||
          !/^(?:40000|100644|100755|120000|160000)$/.test(tree.subarray(offset, space).toString())) return undefined;
      const name = tree.subarray(space + 1, end);
      if (!name.length || name.includes(47) || name.equals(Buffer.from('.')) || name.equals(Buffer.from('..'))) return undefined;
      if (name.equals(Buffer.from(PIN_FILE))) return { drift: canonical };
      offset = end + 21;
    }
    return { project, release: null };
  } catch { return undefined; }
}

export function projectPin(cwd) {
  const precheck = pinPrecheck(cwd);
  if (precheck?.drift) throw Error(`${PIN_FILE} is committed but missing from the canonical working tree; restore it or commit an unpin`);
  if (precheck !== undefined) return precheck;
  // A non-repository retains the historical global launcher behaviour. An
  // identified repository with broken canonical metadata must fail closed.
  let snapshot;
  try { snapshot = gitProject(cwd, { env: projectEnvironment(), timeoutMs: 10000, includeHead: true }); }
  catch (error) {
    if (/not a git repository/.test(String(error.stderr))) return null;
    throw error;
  }
  // Discovery has already identified the canonical checkout and its committed
  // HEAD. Reuse that snapshot instead of spawning two more Git probes for every
  // source CLI child. No selection survives a later admission or HEAD change.
  let { head, ...project } = snapshot;
  try {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head ?? '') || /^0+$/.test(head))
      head = git(project.canonical, ['rev-parse', '--verify', 'HEAD']);
  }
  catch (error) {
    const ref = git(project.canonical, ['symbolic-ref', 'HEAD']);
    const result = spawnSync('git', ['-C', project.canonical, 'show-ref', '--verify', '--quiet', ref], { env: projectEnvironment() });
    if (result.status === 1) return { project, release: null };
    throw error;
  }
  const entry = git(project.canonical, ['ls-tree', head, '--', PIN_FILE]);
  if (!entry) return { project, release: null };
  if (!/^100644 blob |^100755 blob /.test(entry)) throw Error(`${PIN_FILE} must be a committed regular file`);
  if (!fs.lstatSync(path.join(project.canonical, PIN_FILE), { throwIfNoEntry: false }))
    throw Error(`${PIN_FILE} is committed but missing from the canonical working tree; restore it or commit an unpin`);
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
