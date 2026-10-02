// Only for the privileged entry boundary's agent-writable locations. Ordinary
// record and operator-selected configuration IO must retain symlink semantics.
// Reject redirected components and open new files exclusively, without following
// a final symlink. Never reuse a predictable temporary filename.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function absolute(file) {
  let value = path.resolve(file);
  // macOS exposes these system directories through fixed OS-owned aliases.
  for (const prefix of ['/tmp', '/var', '/etc']) {
    if (value === prefix || value.startsWith(`${prefix}/`)) {
      value = fs.realpathSync(prefix) + value.slice(prefix.length);
      break;
    }
  }
  return value;
}
function inDirectory(directory, create, action) {
  const resolved = absolute(directory);
  const previous = process.cwd();
  // Synchronous only: the kernel pins cwd to an inode even if an agent renames
  // its directory. Resolve one component at a time from that pinned directory;
  // compare each entered inode with the O_NOFOLLOW descriptor before using it.
  // No write ever re-resolves an agent-controlled ancestor path.
  try {
    const root = path.parse(resolved).root;
    process.chdir(root);
    for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
      if (create) { try { fs.mkdirSync(component); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
      const fd = fs.openSync(component, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        process.chdir(component);
        const opened = fs.fstatSync(fd), entered = fs.statSync('.');
        if (opened.dev !== entered.dev || opened.ino !== entered.ino) throw new Error(`directory redirected: ${directory}`);
      } finally { fs.closeSync(fd); }
    }
    return action(resolved);
  } finally { process.chdir(previous); }
}
export function plainDirectory(directory, { create = true } = {}) {
  return inDirectory(directory, create, (resolved) => resolved);
}
export function readPlainFile(file, encoding = 'utf8') {
  const resolved = absolute(file);
  return inDirectory(path.dirname(resolved), false, () => {
    const fd = fs.openSync(path.basename(resolved), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error(`not a regular file: ${file}`);
      return fs.readFileSync(fd, encoding);
    } finally { fs.closeSync(fd); }
  });
}
export function removePlainDirectory(directory) {
  const resolved = absolute(directory);
  try {
    return inDirectory(path.dirname(resolved), false, () => {
      fs.rmSync(path.basename(resolved), { recursive: true, force: true });
    });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function writeFileAtomic(file, content, mode = 0o644) {
  const resolved = absolute(file);
  return inDirectory(path.dirname(resolved), true, () => {
    const target = path.basename(resolved);
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`file redirected: ${file}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const temporary = `.${target}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    try {
      fs.writeFileSync(fd, content);
      const opened = fs.fstatSync(fd), named = fs.lstatSync(temporary);
      if (named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error('temporary file redirected');
      fs.renameSync(temporary, target);
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  });
}
