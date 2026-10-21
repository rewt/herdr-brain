// Filesystem proofs used by the shared retirement adapter. No lifecycle policy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadTimeout } from './deadline.mjs';
import { findOrgDir, loadEvents } from './store.mjs';
import { gitProject } from './project.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const DEFAULT_EVIDENCE_MAX_BYTES = 256 * 1024 * 1024;
// Exact directory components, and only when Git confirms the path is ignored.
const DISPOSABLE_DIRECTORIES = new Set(['node_modules', '.pnpm-store', 'dist', 'build', '.cache', 'coverage', 'target']);
const evidenceName = name => /^(?:\.(?:lane|org)|evidence|reports?|diagnostics?|references?|artifacts?|receipts?|logs?)(?:[._-]|$)/i.test(name);
const LIVE_MARKERS = new Set(['.local-live']);

function protectedPaths(lane, env) {
  // Safety declarations belong to the canonical project, never a lane's copy.
  const { canonical } = gitProject(lane, { env, timeoutMs: loadTimeout(10000) });
  let config;
  try {
    const file = path.join(canonical, '.lane.json');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return [];
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { throw Error('protected path configuration unavailable; lane kept'); }
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!record(config) || (config.retirement !== undefined && !record(config.retirement))) throw Error('invalid protected path configuration; lane kept');
  const globs = config.retirement && Object.hasOwn(config.retirement, 'protected_paths') ? config.retirement.protected_paths : [];
  if (!Array.isArray(globs)) throw Error('invalid retirement.protected_paths; lane kept');
  return globs.map(glob => {
    if (typeof glob !== 'string' || !glob || path.isAbsolute(glob) || /[\\\[\]{}!\0]/.test(glob) ||
        glob.split('/').some(part => !part || part === '.' || part === '..' || (part.includes('**') && part !== '**'))) {
      throw Error('invalid retirement.protected_paths glob; lane kept');
    }
    const parts = glob.split('/');
    const source = parts.map((part, index) => part === '**' ? (index === parts.length - 1 ? '.*' : '(?:[^/]+/)*') :
      [...part].map(char => char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') +
      (index === parts.length - 1 ? '' : '/')).join('');
    return new RegExp(`^${source.replace(/\/\.\*$/, '(?:/.*)?')}$`);
  });
}
function durableFile(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function evidenceBudget(env) {
  const override = env.LANE_EVIDENCE_MAX_BYTES;
  const maxBytes = override === undefined ? DEFAULT_EVIDENCE_MAX_BYTES : Number(override);
  if ((override !== undefined && !/^\d+$/.test(override)) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw Error('LANE_EVIDENCE_MAX_BYTES must be a nonnegative safe integer byte count');
  return maxBytes;
}

function ignoredPaths(lane, entries, tracked, env) {
  const candidates = new Set(entries.filter(entry => !tracked.has(entry.path)).map(entry => entry.path));
  if (!candidates.size) return new Set();
  const result = spawnSync('git', ['-C', lane, 'check-ignore', '--stdin', '-z'], {
    input: [...candidates].join('\0') + '\0', encoding: 'utf8', env,
    timeout: loadTimeout(10000), maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status) || result.stderr?.trim() ||
      (result.stdout && !result.stdout.endsWith('\0')) || (result.status === 1 && result.stdout)) throw Error(`evidence ignore classification unavailable; lane kept: ${result.stderr || result.error?.message || result.status}`);
  const ignored = new Set(result.stdout.split('\0').filter(Boolean));
  if ([...ignored].some(file => !candidates.has(file))) throw Error('uncertain evidence ignore classification; lane kept');
  return ignored;
}

function copiedBytes(entries, maxBytes) {
  const bytes = entries.reduce((sum, entry) => sum + (entry.metadataOnly ? 0 : entry.type === 'file' ? entry.size : entry.type === 'symlink' ? Buffer.byteLength(entry.target) : 0), 0);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('evidence size cannot be measured safely; explicit disposition is required');
  if (bytes > maxBytes) throw Error(`evidence size ${bytes} bytes exceeds budget ${maxBytes} bytes; explicit disposition is required; lane kept`);
  return bytes;
}

function evidenceClaims(lane, env) {
  const org = findOrgDir({ cwd: lane, env });
  if (!org) throw Error('evidence/reference claims unavailable; lane kept');
  const { events, tornTail } = loadEvents(org);
  if (tornTail) throw Error('evidence claims unavailable: incomplete record tail; lane kept');
  const localPath = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === lane;
  const runs = events.filter(e => e.type === 'run.started' && localPath(e.workspace));
  const localRuns = new Set(runs.map(e => e.id)), topics = new Set(runs.map(e => e.meta?.lane).filter(Boolean));
  const claims = new Set();
  const strings = (value, local) => {
    if (typeof value === 'string') {
      // A claim is a whole path value, not a word or substring in prose.
      // ./build or build/ explicitly names a directory; bare "build" does not.
      if (!path.isAbsolute(value) && (!local || (value !== '.' && !value.includes('/')))) return;
      const file = path.resolve(lane, value);
      if (inside(file, lane)) claims.add(path.relative(lane, file) || '.');
    } else if (Array.isArray(value)) value.forEach(entry => strings(entry, local));
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        // Context fields bind relative claims; they are not whole-lane claims.
        if (!['lane', 'cwd', 'workspace'].includes(key)) strings(entry, local);
      }
    }
  };
  for (const event of events) {
    // Use declared evidence fields, not generic mentions in titles/acceptance.
    // Relative claims belong to their lane; absolute lane paths always apply.
    const local = localRuns.has(event.run) || localRuns.has(event.id) || localPath(event.cwd) || localPath(event.workspace);
    for (const value of [event.report?.artifacts, event.evidence, event.references, event.artifacts, event.file, event.report_path]) {
      strings(value, local);
    }
  }
  const references = path.join(org, 'references');
  let names;
  try { names = fs.readdirSync(references)
    .filter(name => !name.startsWith('.') && name.endsWith('.json')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; names = []; }
  for (const name of names) {
    const file = path.join(references, name);
    if (!fs.lstatSync(file).isFile()) throw Error('evidence reference source is not a regular file; lane kept');
    const reference = JSON.parse(fs.readFileSync(file, 'utf8'));
    const local = localPath(reference?.cwd) || localPath(reference?.lane) || topics.has(reference?.lane);
    strings(reference, local);
  }
  return claims;
}

function claimed(relative, claims) {
  // Include ancestors: a claim to a directory protects its whole subtree.
  for (let file = relative; ; file = path.dirname(file)) {
    if (claims.has(file)) return true;
    if (file === '.') break;
  }
  return false;
}

// Walk the actual filesystem, including empty directories and nested repositories.
// Only allowlisted, Git-confirmed ignored paths without evidence claims omit payloads.
// With no tracked set this inventories an archive, without consulting Git.
function inventory(lane, tracked, { hash = true, env = process.env, maxBytes = Infinity } = {}) {
  const entries = [], stats = new Map();
  function visit(relative) {
    const file = path.join(lane, relative), stat = fs.lstatSync(file);
    if (relative) {
      const type = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : null;
      if (!type) throw Error(`cannot preserve special evidence file ${relative}`);
      if (type === 'directory' || !tracked?.has(relative)) { entries.push({ path: relative, type }); stats.set(relative, stat); }
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (!relative && name === '.git') continue;
        visit(path.join(relative, name));
      }
    }
  }
  visit('');
  const ignored = tracked ? ignoredPaths(lane, entries, tracked, env) : new Set();
  const allowlisted = relative => relative.split(path.sep).some((name, index, components) => DISPOSABLE_DIRECTORIES.has(name) &&
    ignored.has(components.slice(0, index + 1).join(path.sep)) && stats.get(components.slice(0, index + 1).join(path.sep))?.isDirectory());
  const disposableTree = new Set([...ignored].filter(allowlisted));
  if (tracked) {
    const patterns = protectedPaths(lane, env), trackedParents = new Set();
    for (const file of tracked) for (let parent = path.dirname(file); parent !== '.'; parent = path.dirname(parent)) trackedParents.add(parent);
    for (const entry of entries) {
      // Tracked-only parents are recoverable through Git. Untracked descendants
      // have their own entries and must pass protection even in disposable trees.
      if (trackedParents.has(entry.path)) continue;
      for (let file = entry.path; file !== '.'; file = path.dirname(file)) {
        if (LIVE_MARKERS.has(path.basename(file)) || patterns.some(pattern => pattern.test(file))) {
          throw Error(`protected wallet/secret/live state at ${entry.path}; lane kept without copying`);
        }
      }
    }
  }
  const disposableCandidates = new Set([...disposableTree].filter(relative => !relative.split(path.sep).some(evidenceName)));
  let claims = new Set();
  if (disposableCandidates.size) {
    try { claims = evidenceClaims(lane, env); }
    catch { throw Error('evidence/reference claims unavailable; lane kept'); }
  }
  const disposable = relative => disposableCandidates.has(relative) && !claimed(relative, claims);
  for (const entry of entries) {
    if (disposable(entry.path)) Object.assign(entry, { size: stats.get(entry.path).size, metadataOnly: true });
    else if (entry.type === 'file') entry.size = stats.get(entry.path).size;
    else if (entry.type === 'symlink') {
      entry.target = fs.readlinkSync(path.join(lane, entry.path));
    }
  }
  // Refuse before reading payloads, including when the source grew since pre-tag measurement.
  copiedBytes(entries, maxBytes);
  if (hash) for (const entry of entries.filter(entry => !entry.metadataOnly && entry.type !== 'directory')) {
    const file = path.join(lane, entry.path), stat = stats.get(entry.path);
    let bytes = entry.target;
    if (entry.type === 'file') {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { bytes = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    }
    const after = fs.lstatSync(file);
    if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw Error(`evidence changed while reading ${entry.path}`);
    entry.sha256 = digest(bytes);
  }
  return entries;
}

function copiedEntries(entries) {
  // Recreate parents for preserved evidence within an otherwise disposable tree.
  const parents = new Set();
  for (const entry of entries.filter(entry => !entry.metadataOnly)) {
    for (let parent = path.dirname(entry.path); parent !== '.'; parent = path.dirname(parent)) parents.add(parent);
  }
  return entries.flatMap(entry => !entry.metadataOnly ? [entry] : entry.type === 'directory' && parents.has(entry.path) ? [{ path: entry.path, type: 'directory' }] : []);
}

export function measureLaneEvidence({ lane, tracked, env = process.env }) {
  if (!(tracked instanceof Set)) throw Error('tracked evidence inventory unavailable; lane kept');
  const maxBytes = evidenceBudget(env), entries = inventory(lane, tracked, { hash: false, env, maxBytes });
  const bytes = copiedBytes(entries, maxBytes);
  return { bytes, maxBytes };
}

// Crash recovery verifies the durable copy independently of the removed source.
// The record supplies the manifest hash and exact removed path/head.
export function verifyPreservedLaneEvidence({ common, proof, env = process.env }) {
  const { directory, manifest, sha256 } = proof.evidence ?? {};
  const root = path.join(fs.realpathSync(common), 'lane-archive', proof.branch.slice(5));
  if (!directory?.startsWith(root + path.sep) || fs.realpathSync(directory) !== directory || manifest !== path.join(directory, 'sha256.json')) throw Error('preserved evidence path identity changed');
  const bytes = fs.readFileSync(manifest), saved = JSON.parse(bytes);
  if (digest(bytes) !== sha256 || saved.schema !== 'lane-evidence/v2' || saved.lane !== proof.cwd || saved.tip !== proof.tip || !Array.isArray(saved.entries)) throw Error('preserved evidence manifest identity changed');
  if (JSON.stringify(inventory(path.join(directory, 'files'), undefined, { maxBytes: evidenceBudget(env) })) !== JSON.stringify(copiedEntries(saved.entries))) throw Error('preserved evidence inventory changed');
}

export function preserveLaneEvidence({ common, lane, topic, tip, tracked, io = fs, env = process.env }) {
  if (!(tracked instanceof Set)) throw Error('tracked evidence inventory unavailable; lane kept');
  common = fs.realpathSync(common); lane = fs.realpathSync(lane);
  if (inside(common, lane)) throw Error('evidence destination is inside the swept worktree');
  // Size-only inventory precedes archive creation and payload reads/copies.
  // Repeat the caller's pre-tag measurement in case contents grew meanwhile.
  const maxBytes = evidenceBudget(env), entries = inventory(lane, tracked, { env, maxBytes });
  const copied = copiedEntries(entries);
  const directory = path.join(common, 'lane-archive', topic, `${Date.now()}-${randomUUID()}`);
  for (const parent of [path.join(common, 'lane-archive'), path.join(common, 'lane-archive', topic)]) {
    try { fs.mkdirSync(parent); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (!fs.lstatSync(parent).isDirectory() || fs.realpathSync(parent) !== parent) throw Error('unsafe evidence archive directory');
  }
  fs.mkdirSync(directory);
  const data = path.join(directory, 'files'); fs.mkdirSync(data);
  for (const entry of copied) {
    const source = path.join(lane, entry.path), target = path.join(data, entry.path);
    if (entry.type === 'directory') fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (entry.type === 'symlink') io.symlinkSync(entry.target, target);
      else {
        io.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    }
  }
  const manifest = path.join(directory, 'sha256.json');
  durableFile(manifest, JSON.stringify({ schema: 'lane-evidence/v2', lane, tip, entries }, null, 2) + '\n');
  for (const entry of copied.filter(e => e.type === 'directory').reverse()) syncDirectory(path.join(data, entry.path));
  for (const dir of [data, directory, path.dirname(directory), path.dirname(path.dirname(directory)), common]) syncDirectory(dir);
  const sha256 = digest(fs.readFileSync(manifest));
  const verify = () => {
    const bytes = fs.readFileSync(manifest);
    if (digest(bytes) !== sha256) throw Error('evidence manifest hash mismatch');
    const saved = JSON.parse(bytes);
    if (saved.schema !== 'lane-evidence/v2' || !Array.isArray(saved.entries)) throw Error('evidence manifest schema mismatch');
    if (JSON.stringify(inventory(data, undefined, { maxBytes })) !== JSON.stringify(copiedEntries(saved.entries)) ||
        JSON.stringify(inventory(lane, tracked, { env, maxBytes })) !== JSON.stringify(saved.entries)) throw Error('evidence copy hash or inventory mismatch; lane kept');
  };
  verify();
  // The evidence inventory omits tracked files: Git already preserves them,
  // but worktree removal still has to unlink them along with every directory.
  return { directory, manifest, sha256, verify, entryCount: entries.length + tracked.size };
}

// access(W_OK) alone does not exercise sandbox file-write/unlink permissions.
// Probe create, rename, unlink and rmdir in every affected metadata directory,
// and open existing metadata for writing without changing its bytes.
export function preflightGitMetadata({ common, gitDirectory, branch, io = fs }) {
  const directories = new Set([common]);
  function visit(directory) {
    const stat = io.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`unsafe Git metadata directory ${directory}`);
    directories.add(directory);
    for (const name of io.readdirSync(directory)) {
      if (name.endsWith('.lock')) throw Error(`locked Git metadata ${path.join(directory, name)}`);
      const file = path.join(directory, name), stat = io.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else {
        if (!stat.isFile()) throw Error(`unsafe Git metadata ${file}`);
        const fd = io.openSync(file, 'r+'); io.closeSync(fd);
      }
    }
  }
  if (gitDirectory) { visit(gitDirectory); directories.add(path.dirname(gitDirectory)); }
  // pack-refs can prune loose-ref directories. Recreate the branch namespace
  // one component at a time, verifying each before using its exact lock name.
  for (const relative of ['refs', 'refs/heads', path.dirname(`refs/heads/${branch}`)]) {
    const directory = path.join(common, relative);
    try { io.mkdirSync(directory); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (!io.lstatSync(directory).isDirectory() || io.realpathSync(directory) !== directory) throw Error(`unsafe Git metadata directory ${directory}`);
    directories.add(directory);
  }
  for (const relative of ['refs', 'refs/heads', path.dirname(`refs/heads/${branch}`), 'logs', 'logs/refs', 'logs/refs/heads', path.dirname(`logs/refs/heads/${branch}`)]) {
    const directory = path.join(common, relative);
    if (io.existsSync(directory)) directories.add(directory);
  }
  for (const relative of [`refs/heads/${branch}`, `logs/refs/heads/${branch}`, 'packed-refs']) {
    const file = path.join(common, relative);
    if (io.existsSync(file)) { const fd = io.openSync(file, 'r+'); io.closeSync(fd); }
  }
  for (const directory of directories) {
    if (!io.lstatSync(directory).isDirectory() || io.realpathSync(directory) !== directory) throw Error(`unsafe Git metadata directory ${directory}`);
    const probe = path.join(directory, `.lane-close-preflight-${randomUUID()}`), renamed = probe + '-renamed';
    io.mkdirSync(probe);
    try {
      const file = path.join(probe, 'probe'), fd = io.openSync(file, 'wx'); io.closeSync(fd);
      io.renameSync(file, file + '-renamed'); io.unlinkSync(file + '-renamed');
      io.renameSync(probe, renamed); io.rmdirSync(renamed);
    } finally {
      for (const file of [probe, renamed]) if (io.existsSync(file)) io.rmSync(file, { recursive: true });
    }
  }
  for (const file of [path.join(common, `refs/heads/${branch}.lock`), path.join(common, 'packed-refs.lock')]) {
    // Exact lock names catch an existing writer before the worktree is swept.
    const fd = io.openSync(file, 'wx'); io.closeSync(fd); io.unlinkSync(file);
  }
}

export function readLaneCwdReferences(lane, { command = spawnSync, platform = process.platform, env = process.env } = {}) {
  const references = [];
  const add = (pid, cwd) => { if (inside(cwd, lane)) references.push({ kind: 'process cwd', job: String(pid), cwd }); };
  if (platform === 'darwin') {
    const result = command('/usr/sbin/lsof', ['-a', '-u', String(process.getuid()), '-d', 'cwd', '-Fpn0'],
      { encoding: 'utf8', env, timeout: loadTimeout(10000), maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0 || result.stderr?.trim() || !result.stdout?.endsWith('\n')) throw Error(`process cwd source unavailable: ${result.stderr || result.error?.message || result.status}`);
    let pid, anchor = false;
    for (const field of result.stdout.split('\0')) {
      const value = field.replace(/^\n/, '');
      if (value.startsWith('p')) { pid = Number(value.slice(1)); if (!Number.isSafeInteger(pid) || pid < 1) throw Error('incomplete process cwd identity'); }
      else if (value.startsWith('n')) {
        if (!pid || !path.isAbsolute(value.slice(1))) throw Error('incomplete process cwd path');
        if (pid === process.pid) anchor = true;
        add(pid, value.slice(1));
      }
    }
    if (!anchor) throw Error('process cwd snapshot omitted its caller');
  } else if (platform === 'linux') {
    for (const name of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
      try {
        if (fs.statSync(`/proc/${name}`).uid !== process.getuid()) continue;
        const cwd = fs.readlinkSync(`/proc/${name}/cwd`); add(Number(name), cwd);
      } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
    }
  } else throw Error(`process cwd source unavailable on ${platform}`);
  return references;
}

// A failed/incomplete observation gives no deletion proof. On macOS the sweep
// selects candidate trees, unlinked files (which +D cannot find), and the caller
// cwd as a completeness anchor. Selection is ORed: adding -a/-u here would lose
// either unlinked files or the bound. Other users' matching handles also keep
// scratch, conservatively. +D also skips symlink inodes, so trees containing
// symlinks retain the full user inventory. Linux's /proc inventory is unchanged.
export function readProcessFileReferences({ command = spawnSync, platform = process.platform, env = process.env, directories } = {}) {
  const references = [];
  const aliases = [...new Set([os.tmpdir(), '/tmp', '/private/tmp'])].flatMap(root => {
    try { return [{ from: root, to: fs.realpathSync(root) }]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }).sort((a, b) => b.from.length - a.from.length);
  // Like the cwd inventory, retain the kernel-reported absolute names. Do not
  // lstat every open file: unlinked files and inaccessible system files still
  // have valid native observations. Normalize the temporary root aliases only.
  const nativePath = file => {
    const alias = aliases.find(root => inside(file, root.from));
    return alias ? path.join(alias.to, path.relative(alias.from, file)) : file;
  };
  if (platform === 'darwin') {
    if (directories !== undefined && (!Array.isArray(directories) || directories.some(directory =>
      typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0'))))
      throw Error('invalid open file candidate directories');
    if (directories?.length === 0) return references;
    const candidates = directories && [...new Set(directories)];
    const hasSymlink = directory => {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('open file candidate is not a directory');
      return fs.readdirSync(directory, { withFileTypes: true }).some(child => child.isSymbolicLink() ||
        (child.isDirectory() && hasSymlink(path.join(directory, child.name))));
    };
    // A directly opened symlink (macOS O_SYMLINK) is invisible to +D, even
    // though the full inventory reports it. Do not turn that gap into absence.
    const bounded = candidates !== undefined && !candidates.some(hasSymlink);
    const args = bounded
      ? ['-n', '-P', '-Fpfn0', '+L1', ...candidates.flatMap(directory => ['+D', directory]), '--', process.cwd()]
      : ['-n', '-P', '-a', '-u', String(process.getuid()), '-Fpfn0'];
    const result = command('/usr/sbin/lsof', args,
      { encoding: 'utf8', env, timeout: loadTimeout(10000), maxBuffer: 64 * 1024 * 1024 });
    // lsof 4.91 returns 1 when any selected tree member has no open handle.
    // That is normal for a bounded search, but never substitutes for the caller
    // anchor, complete field records, empty stderr, and a non-error exit.
    if (result.error || (result.status !== 0 && !(bounded && result.status === 1)) || result.signal ||
        result.stderr?.trim() || !result.stdout?.endsWith('\0\n'))
      throw Error(`open file source unavailable: ${result.stderr || result.error?.message || result.status}`);
    let pid, fd, named = false, anchor = false;
    for (const field of result.stdout.split('\0')) {
      const value = field.replace(/^\n/, '');
      if (value.startsWith('p')) {
        if (pid && !named) throw Error('incomplete open file record');
        pid = Number(value.slice(1)); fd = undefined;
        if (!/^[1-9]\d*$/.test(value.slice(1)) || !Number.isSafeInteger(pid)) throw Error('incomplete open file process identity');
        named = false;
      } else if (value.startsWith('f')) {
        if (fd && !named) throw Error('incomplete open file record');
        fd = value.slice(1); named = false;
        if (!pid || !fd || /^(?:err|NOFD)$/i.test(fd)) throw Error('incomplete open file identity');
      } else if (value.startsWith('n')) {
        if (!pid || !fd || named) throw Error('incomplete open file identity');
        const file = value.slice(1); named = true;
        if ((bounded || fd === 'cwd') && !path.isAbsolute(file)) throw Error('incomplete open file path');
        if (pid === process.pid && fd === 'cwd') anchor = true;
        // Sockets, pipes and kernel objects have non-path names.
        if (path.isAbsolute(file)) references.push({ pid, path: nativePath(file) });
      } else if (value) throw Error('incomplete open file fields');
    }
    if (!named) throw Error('incomplete open file record');
    if (!anchor) throw Error('open file snapshot omitted its caller cwd');
  } else if (platform === 'linux') {
    for (const name of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
      try {
        if (fs.statSync(`/proc/${name}`).uid !== process.getuid()) continue;
        for (const entry of ['cwd', 'root', 'exe', ...fs.readdirSync(`/proc/${name}/fd`).map(fd => `fd/${fd}`)]) {
          try {
            const file = fs.readlinkSync(`/proc/${name}/${entry}`);
            if (path.isAbsolute(file)) references.push({ pid: Number(name), path: nativePath(file) });
          } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
        }
        // mmap can retain a file after its fd has closed.
        for (const line of fs.readFileSync(`/proc/${name}/maps`, 'utf8').split('\n')) {
          const file = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/)?.[1];
          if (file) references.push({ pid: Number(name), path: nativePath(file.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)))) });
        }
      } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
    }
  } else throw Error(`open file source unavailable on ${platform}`);
  return references;
}
