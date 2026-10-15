// Filesystem proofs used by the shared retirement adapter. No lifecycle policy.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadTimeout } from './deadline.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
function durableFile(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Enumerate the actual filesystem, including ignored directories and nested
// repositories. Git's directory/file list alone is not evidence preservation.
function inventory(lane, tracked) {
  const entries = [];
  function visit(relative) {
    const file = path.join(lane, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      if (relative) entries.push({ path: relative, type: 'directory' });
      for (const name of fs.readdirSync(file).sort()) {
        if (!relative && name === '.git') continue;
        visit(path.join(relative, name));
      }
    } else if (!tracked.has(relative)) {
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        entries.push({ path: relative, type: 'symlink', target, sha256: digest(target) });
      } else if (stat.isFile()) {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let bytes;
        try { bytes = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
        const after = fs.lstatSync(file);
        if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw Error(`evidence changed while reading ${relative}`);
        entries.push({ path: relative, type: 'file', size: bytes.length, sha256: digest(bytes) });
      } else throw Error(`cannot preserve special evidence file ${relative}`);
    }
  }
  visit('');
  // Directory entries also preserve empty directories and the original layout.
  return entries;
}

export function preserveLaneEvidence({ common, lane, topic, tip, tracked, io = fs }) {
  common = fs.realpathSync(common); lane = fs.realpathSync(lane);
  if (inside(common, lane)) throw Error('evidence destination is inside the swept worktree');
  const directory = path.join(common, 'lane-archive', topic, `${Date.now()}-${randomUUID()}`);
  for (const parent of [path.join(common, 'lane-archive'), path.join(common, 'lane-archive', topic)]) {
    try { fs.mkdirSync(parent); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (!fs.lstatSync(parent).isDirectory() || fs.realpathSync(parent) !== parent) throw Error('unsafe evidence archive directory');
  }
  fs.mkdirSync(directory);
  const data = path.join(directory, 'files'); fs.mkdirSync(data);
  const entries = inventory(lane, tracked);
  for (const entry of entries) {
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
  durableFile(manifest, JSON.stringify({ schema: 'lane-evidence/v1', lane, tip, entries }, null, 2) + '\n');
  for (const entry of entries.filter(e => e.type === 'directory').reverse()) syncDirectory(path.join(data, entry.path));
  for (const dir of [data, directory, path.dirname(directory), path.dirname(path.dirname(directory)), common]) syncDirectory(dir);
  const sha256 = digest(fs.readFileSync(manifest));
  const verify = () => {
    const bytes = fs.readFileSync(manifest);
    if (digest(bytes) !== sha256) throw Error('evidence manifest hash mismatch');
    const saved = JSON.parse(bytes);
    if (JSON.stringify(inventory(data, new Set())) !== JSON.stringify(saved.entries) ||
        JSON.stringify(inventory(lane, tracked)) !== JSON.stringify(saved.entries)) throw Error('evidence copy hash or inventory mismatch; lane kept');
  };
  verify();
  return { directory, manifest, sha256, verify };
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
