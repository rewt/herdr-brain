// Release selection is project configuration, never inherited run metadata.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { gitProject } from './project.mjs';
import { homeBindings, homeProject, policyLocation, present, configDrift } from './config-home.mjs';
import { readPolicySnapshot } from './config-policy.mjs';

export const PIN_FILE = '.herdr-release.json';
export const releaseHome = () => path.join(os.userInfo().homedir, '.local/share/herdr-monitor');
// Git's inherited repository/index/config selectors must not choose the project.
export const projectEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, args, { trim = true } = {}) => {
  const output = execFileSync('git', ['-C', cwd, ...args], {
    env: projectEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  });
  return trim ? output.trim() : output;
};
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
    if (present(path.join(canonical, '.brain')) || homeBindings(projectEnvironment()).bindings.length) return undefined;
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
  const snapshot = pinSnapshot(cwd);
  if (!snapshot) return null;
  const binding = homeProject(cwd, projectEnvironment(), { git: snapshot });
  if (binding) {
    const selected = policyLocation(cwd, 'pin', projectEnvironment(), { binding });
    if (selected.home) {
      const policy = readPolicySnapshot(selected.file, 'pin', { cwd, env: projectEnvironment() });
      const { head, ...project } = snapshot;
      return { project, release: policy.config.release, config_commit: head, config_digest: policy.digest, file: selected.file, home_binding: binding.file };
    }
    return { ...committedPin(snapshot), home_binding: binding.file };
  }
  return committedPin(snapshot);
}

function pinSnapshot(cwd) {
  // A non-repository retains the historical global launcher behaviour. An
  // identified repository with broken canonical metadata must fail closed.
  try { return gitProject(cwd, { env: projectEnvironment(), timeoutMs: 10000, includeHead: true }); }
  catch (error) {
    if (/not a git repository/.test(String(error.stderr))) return null;
    throw error;
  }
}

function committedPin(snapshot) {
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

// Acceptance is distribution evidence, never project configuration. Legacy
// protocol-1 bundles can carry a write-once installation attestation instead.
export function acceptanceRecord(bytes, commit) {
  const summary = JSON.parse(bytes);
  if (summary.ready !== true) throw Error('acceptance-not-ready: summary is not READY');
  if (summary.candidateCommit !== commit) throw Error('acceptance-commit-mismatch: summary does not describe the bundle commit');
  if (!summary.counts || ['PASS', 'FAIL', 'PENDING', 'SKIP'].some(key => !Number.isSafeInteger(summary.counts[key]) || summary.counts[key] < 0) ||
      summary.counts.FAIL || summary.counts.PENDING || !Number.isFinite(summary.elapsedSeconds) || summary.elapsedSeconds < 0)
    throw Error('acceptance-invalid: invalid counts or elapsed seconds');
  return { ran: true, ready: true, counts: summary.counts, candidateCommit: summary.candidateCommit,
    elapsedSeconds: summary.elapsedSeconds, summarySha256: sha(bytes) };
}

export function releaseAcceptance(release, home = path.dirname(path.dirname(release.root))) {
  home = fs.realpathSync(home);
  const manifest = JSON.parse(fs.readFileSync(path.join(release.root, '.release-manifest.json'), 'utf8'));
  let record = manifest.acceptance, source = 'manifest';
  if (record === undefined) {
    source = 'attestation';
    try {
      const file = path.join(home, 'acceptance', `${validReleaseId(release.id)}.json`);
      if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== path.resolve(file)) throw Error('acceptance-invalid: attestation must be a regular file');
      const attestation = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (attestation.schema !== 'herdr-release-acceptance/v1' || attestation.release !== release.id || attestation.commit !== release.commit)
        throw Error('acceptance-commit-mismatch: attestation does not describe this bundle');
      record = attestation.acceptance;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { ready: false, reason: 'acceptance-missing' };
    }
  }
  if (record?.ran !== true || record.ready !== true) return { ready: false, source, reason: 'acceptance-not-ready' };
  if (record.candidateCommit !== release.commit) return { ready: false, source, reason: 'acceptance-commit-mismatch' };
  if (!/^[a-f0-9]{64}$/.test(record.summarySha256 ?? '') || !record.counts ||
      ['PASS', 'FAIL', 'PENDING', 'SKIP'].some(key => !Number.isSafeInteger(record.counts[key]) || record.counts[key] < 0) ||
      record.counts.FAIL || record.counts.PENDING || !Number.isFinite(record.elapsedSeconds) || record.elapsedSeconds < 0)
    return { ready: false, source, reason: 'acceptance-invalid' };
  // The manifest records the exact retained summary, outside the runtime file
  // inventory. Legacy attestations retain the compact result and its digest.
  if (source === 'manifest') {
    const file = path.join(release.root, '.release-acceptance.json');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() || fs.realpathSync(file) !== file || sha(fs.readFileSync(file)) !== record.summarySha256)
      return { ready: false, source, reason: 'acceptance-summary-mismatch' };
    const summary = acceptanceRecord(fs.readFileSync(file), release.commit);
    if (summary.elapsedSeconds !== record.elapsedSeconds || ['PASS', 'FAIL', 'PENDING', 'SKIP'].some(key => summary.counts[key] !== record.counts[key]))
      return { ready: false, source, reason: 'acceptance-summary-mismatch' };
  }
  return { ...record, source };
}

export function requireReadyAcceptance(release, home) {
  const acceptance = releaseAcceptance(release, home);
  if (!acceptance.ready) throw Error(`${acceptance.reason}: release ${release.id} needs READY acceptance for ${release.commit}`);
  return release;
}
export function requireHomeRelease(id, binding, home = releaseHome()) {
  const release = id ? checkRelease(home, id, { verifyFiles: true }) : checkBundle(fs.realpathSync(path.join(home, 'current')), { verifyFiles: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(release.root, '.release-manifest.json'), 'utf8'));
  if (manifest.config_home !== 1) throw Error(`incompatible downgrade: ${release.id} cannot read adopted home policy`);
  return requireReadyAcceptance(release, home);
}

export function selectRelease(cwd = process.cwd(), home = releaseHome(), { fallbackRoot, pin = projectPin(cwd) } = {}) {
  if (pin?.release) return { ...(pin.home_binding ? requireHomeRelease(pin.release, null, home) : requireReadyAcceptance(checkRelease(home, pin.release), home)), selection: 'project', identity: pin.project.identity, config_commit: pin.config_commit,
    ...(pin.config_digest ? { config_digest: pin.config_digest, config_file: pin.file } : {}) };
  if (pin?.home_binding) return { ...requireHomeRelease(null, null, home), selection: 'current', identity: pin.project.identity,
    ...(pin.config_digest ? { config_digest: pin.config_digest, config_file: pin.file } : {}) };
  // Legacy unpinned releases need no new manifest. Resolve current exactly once.
  const root = fs.realpathSync(fallbackRoot ?? path.join(home, 'current'));
  if (pin?.home_binding) requireHomeRelease(null, null, home);
  return { ...bundleRelease(root), selection: fallbackRoot ? 'bundle' : 'current', ...(pin ? { identity: pin.project.identity } : {}) };
}

export function pinStatus(cwd = process.cwd(), home = releaseHome()) {
  // Unlike hot-path admission, read-back always needs the HEAD sha, even when
  // no pin exists. Reuse that exact snapshot through selection and display.
  const snapshot = pinSnapshot(cwd);
  let pin = null, admissionError;
  try { pin = snapshot ? projectPin(cwd) : null; }
  catch (error) { admissionError = error.message; }
  const { head, ...project } = snapshot ?? {};
  let committed = null, prepared = null;
  if (snapshot) {
    const commit = pin?.config_commit ?? (head && !/^0+$/.test(head) ? head : null);
    committed = { commit };
    const file = path.join(project.canonical, PIN_FILE);
    let accepted = null;
    try {
      const entry = commit ? git(project.canonical, ['ls-tree', commit, '--', PIN_FILE]) : '';
      accepted = entry ? git(project.canonical, ['show', `${commit}:${PIN_FILE}`], { trim: false }) : null;
      committed.bytes = accepted;
      if (accepted === null) committed.release = null;
      // Display readable committed data even when it cannot authorize an
      // admission. It is never passed back into the release selector.
      if (accepted !== null) {
        try {
          const config = JSON.parse(accepted);
          if (config && Object.hasOwn(config, 'release')) committed.release = config.release;
        } catch { /* The raw bytes and admission error explain invalid JSON. */ }
      }
    } catch (error) { committed.error = error.message; admissionError ??= error.message; }
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    const working = stat?.isFile() ? fs.readFileSync(file, 'utf8') : null;
    if (admissionError || (stat && !stat.isFile()) || working !== accepted) {
      prepared = { label: 'prepared, not accepted', present: !!stat, bytes: working };
      if (working !== null) {
        try { prepared.config = JSON.parse(working); }
        catch { prepared.error = 'invalid pin JSON'; }
      } else if (stat) prepared.error = 'pin is not a regular file';
    }
  }
  let current = null;
  try { current = fs.realpathSync(path.join(home, 'current')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let resolved;
  try { if (!admissionError) resolved = selectRelease(cwd, home, { pin }); }
  catch (error) {
    admissionError = error.message;
    // Read-back still describes an unready target, while explicitly reporting
    // the same refusal the admission resolver returned.
    try { resolved = pin?.release ? checkRelease(home, pin.release) : null; } catch { /* Invalid target is unavailable. */ }
  }
  if (resolved) {
    let manifestCommit = null, acceptance = { ready: false, reason: 'acceptance-missing' };
    try {
      manifestCommit = JSON.parse(fs.readFileSync(path.join(resolved.root, '.release-manifest.json'), 'utf8')).commit;
      acceptance = releaseAcceptance(resolved, home);
    } catch (error) { if (error.code !== 'ENOENT') acceptance = { ready: false, reason: error.message }; }
    resolved = { ...resolved, manifestCommit, acceptance };
  }
  return { project: snapshot ? project : null, committed, prepared, resolved: resolved ?? null, current,
    ...(pin?.home_binding ? { home: { file: pin.file, release: pin.release, sha256: pin.config_digest, binding: pin.home_binding } } : {}), ...(admissionError ? { admissionError } : {}) };
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
    ? '--repo' : ['housekeeping/housekeeping.mjs', 'watch/watch.mjs', 'dispatch/record-worker.mjs'].includes(relative) ? '--cwd' : null;
  let projectCwd = cwd;
  if (option) {
    // Match the entry's explicit project option, without interpreting any
    // other command data. Execution keeps the caller's cwd and exact argv.
    for (let index = 0; index < args.length && args[index] !== '--'; index++) {
      if (args[index] === option && args[index + 1]) projectCwd = path.resolve(cwd, args[++index]);
      else if (args[index].startsWith(`${option}=`)) projectCwd = path.resolve(cwd, args[index].slice(option.length + 1));
    }
  }
  let release;
  try { release = selectRelease(projectCwd, home, { fallbackRoot }); }
  catch (error) {
    if (relative === 'bin/org.mjs' && ['config', 'adopt'].includes(args[0])) {
      for (const drift of configDrift(homeProject(projectCwd))) process.stderr.write(`${drift.warning}\n`);
    }
    throw error;
  }
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
  if (!pin?.release && !pin?.home_binding) return null;
  if (!actual.commit) {
    // A project's own checkout and lanes are development entry points. Other
    // projects' source bundles still route through the target project's pin.
    let identity;
    try { identity = fs.realpathSync(git(actual.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])); }
    catch (error) { if (!/not a git repository/.test(String(error.stderr))) throw error; }
    if (identity === pin.project.identity && !pin.home_binding) return null;
  }
  const home = actual.commit ? path.dirname(path.dirname(actual.root)) : releaseHome();
  const selected = pin.home_binding ? selectRelease(cwd, home, { pin }) : requireReadyAcceptance(checkRelease(home, pin.release), home);
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
