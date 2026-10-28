// One distribution inventory for release copies and copied product fixtures.
// Copy whole runtime modules so adding a relative import needs no fixture edit.
import fs, { observeGit } from './record-observation.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readPlainFile } from './files.mjs';

const modules = ['bin', 'lib', 'lanes', 'discovery', 'herdr', 'housekeeping', 'dispatch', 'watch',
  'settle', 'promote', 'test-slot', 'verify', 'supervisor', 'brain', 'messages', 'contrib', 'sessions', 'setup', 'logs', 'board', 'line-service'];
const omit = new Set(['node_modules', 'test', 'tests', 'docs', '.git', '.org', '.lane']);
// Data read by bundled commands belongs to the distribution even under docs/.
const assets = ['package.json', '.nvmrc', 'lanes/docs/REVIEW_TEMPLATE.md', 'docs/contracts/formats.json'];
export const releaseMetadata = ['.release-validation.json', '.release-acceptance.json', '.release-commit', '.release-manifest.json'];
export const payloadDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimePath = file => assets.includes(file) || (modules.includes(file.split('/')[0]) &&
  file.split('/').slice(1).every(part => !omit.has(part) && !part.endsWith('.test.mjs')));
export const checkoutGit = (cwd, args) => {observeGit(cwd);return execFileSync('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();};
export function payloadEntry(root, file) {
  const target = path.join(root, file), stat = fs.lstatSync(target);
  if (!stat.isFile() || fs.realpathSync(target) !== target) throw Error(`payload redirected: ${file}`);
  return { mode: stat.mode & 0o111 ? '100755' : '100644', sha256: payloadDigest(readPlainFile(target, null)) };
}

// Generic source authority includes genuine canonical, linked and shared checkouts.
export function captureProductCheckout(directory, expected, { all = false, git = checkoutGit } = {}) {
  const root = fs.realpathSync(directory), commit = git(root, ['rev-parse', 'HEAD']).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || (expected && commit !== expected) ||
      fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root) throw Error('source checkout identity mismatch');
  if (releaseMetadata.some(file => fs.lstatSync(path.join(root, file), { throwIfNoEntry: false }))) throw Error('source checkout has release metadata');
  if (git(root, ['ls-files', '-v', '-z']).split('\0').some(row => /^[a-zS] /.test(row))) throw Error('source index flags hide checkout identity');
  if (git(root, ['status', '--porcelain', '--untracked-files=no'])) throw Error('source checkout is not clean');
  const entries = git(root, ['ls-tree', '-rz', commit]).split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw Error('invalid committed inventory');
    return { mode: match[1], type: match[2], blob: match[3], file: match[4] };
  }).filter(row => all || runtimePath(row.file));
  const runtime = entries.filter(row => runtimePath(row.file)).map(row => row.file).sort();
  if (JSON.stringify(runtime) !== JSON.stringify(productFiles(root).sort())) throw Error('source runtime inventory mismatch');
  const files = Object.create(null);
  for (let start = 0; start < entries.length; start += 256) {
    const batch = entries.slice(start, start + 256);
    if (batch.some(row => row.type !== 'blob' || !/^100(?:644|755)$/.test(row.mode) ||
        /[\r\n\\]/.test(row.file) || row.file.split('/').some(part => !part || part === '.' || part === '..'))) throw Error('unsupported committed payload');
    const blobs = git(root, ['hash-object', '--no-filters', '--', ...batch.map(row => row.file)]).trim().split('\n');
    batch.forEach((row, index) => {
      const actual = payloadEntry(root, row.file);
      if (row.blob !== blobs[index] || row.mode !== actual.mode) throw Error(`committed payload mismatch: ${row.file}`);
      files[row.file] = actual;
    });
  }
  const identity = { root, common: fs.realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()),
    commit, tree: git(root, ['rev-parse', `${commit}^{tree}`]).trim(), files, runtime };
  if (git(root, ['rev-parse', 'HEAD']).trim() !== commit || git(root, ['status', '--porcelain', '--untracked-files=no'])) throw Error('source moved during capture');
  return identity;
}

// Isolation is a construction requirement, never a restriction on generic sources.
export function createProductCheckout({ source, commit, destination, ownedRoot, git = checkoutGit }) {
  source = fs.realpathSync(source);
  const owned = fs.realpathSync(ownedRoot), relative = path.relative(owned, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.realpathSync(path.dirname(destination)) !== path.dirname(destination) ||
      fs.lstatSync(destination, { throwIfNoEntry: false })) throw Error('checkout destination is not new owned scratch');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw Error('checkout requires immutable commit');
  git(source, ['clone', '--quiet', '--no-local', '--no-hardlinks', '--no-checkout', '--', source, destination]);
  git(destination, ['checkout', '--quiet', '--detach', commit]);
  return verifyProductCheckoutIsolation(captureProductCheckout(destination, commit, { all: true, git }), git);
}

export function verifyProductCheckoutIsolation(result, git = checkoutGit) {
  const destination = result.root, metadata = path.join(destination, '.git');
  if (result.common !== metadata || !fs.lstatSync(metadata).isDirectory() || git(destination, ['branch', '--show-current']).trim() ||
      fs.lstatSync(path.join(metadata, 'objects/info/alternates'), { throwIfNoEntry: false })) throw Error('constructed checkout metadata is not private');
  function audit(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) audit(file);
      else if (!stat.isFile() || stat.nlink !== 1) throw Error('constructed checkout shares or redirects metadata');
    }
  }
  audit(metadata);
  if (Object.keys(result.files).some(file => fs.lstatSync(path.join(destination, file)).nlink !== 1)) throw Error('constructed checkout shares payload hardlinks');
  return result;
}

export function verifyProductPayload(directory, captured, { metadata = [], readOnly = false } = {}) {
  const root = fs.realpathSync(directory), names = [], expected = Object.keys(captured.files).sort();
  if (root !== path.resolve(directory)) throw Error('package payload root is redirected');
  const directories = new Set(expected.flatMap(file => file.split('/').slice(0, -1).map((_, i) => file.split('/').slice(0, i + 1).join('/'))));
  function visit(relative = '') {
    const directory = path.join(root, relative);
    if (readOnly && (fs.lstatSync(directory).mode & 0o222)) throw Error('package is writable');
    for (const name of fs.readdirSync(directory)) {
      const file = relative ? `${relative}/${name}` : name, target = path.join(root, file), stat = fs.lstatSync(target);
      if (stat.isDirectory() && directories.has(file)) visit(file);
      else {
        if (readOnly && (stat.mode & 0o222)) throw Error('package is writable');
        const actual = payloadEntry(root, file);
        if (!metadata.includes(file)) {
          names.push(file);
          if (JSON.stringify(actual) !== JSON.stringify(captured.files[file])) throw Error(`package payload mismatch: ${file}`);
        }
      }
    }
  }
  visit();
  if (JSON.stringify(names.sort()) !== JSON.stringify(expected)) throw Error('package inventory mismatch');
  return payloadDigest(JSON.stringify(captured.files));
}

export function productFiles(root) {
  const result = [];
  function visit(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) if (!omit.has(name) && !name.endsWith('.test.mjs')) visit(path.join(relative, name));
    } else if (stat.isFile()) result.push(relative);
    else throw new Error(`runtime source is not a plain file: ${file}`);
  }
  // Older releases and deliberately small test products may lack modules.
  for (const name of [...modules, ...assets]) if (fs.existsSync(path.join(root, name))) visit(name);
  if (fs.existsSync(path.join(root, 'lanes/lane.mjs')) && !fs.existsSync(path.join(root, 'lanes/docs/REVIEW_TEMPLATE.md'))) throw new Error('product runtime is missing the lane review template');
  return result.sort((a, b) => a.localeCompare(b));
}

export function copyProduct(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of productFiles(source)) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relative), target);
  }
}
