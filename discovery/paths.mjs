// Writable sandbox grants are privileged. Do not turn an agent-controlled
// symlink into an authority-bearing real path, even when its target exists.
import fs from 'node:fs';
import path from 'node:path';
import { plainDirectory } from '../lib/files.mjs';

export const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

export function checkedDirectory(directory) {
  let absolute = path.resolve(directory);
  // Preserve only fixed, root-owned macOS aliases. All components beneath the
  // resulting system prefix still undergo the same no-follow inspection.
  for (const prefix of ['/tmp', '/var', '/etc']) if (absolute === prefix || absolute.startsWith(`${prefix}/`)) {
    const entry = fs.lstatSync(prefix), target = fs.realpathSync(prefix);
    if (entry.isSymbolicLink() && entry.uid !== 0) throw new Error(`writable path redirected: ${directory}`);
    absolute = target + absolute.slice(prefix.length); break;
  }
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of [root, ...absolute.slice(root.length).split(path.sep).filter(Boolean)]) {
    current = component === root ? root : path.join(current, component);
    const named = fs.lstatSync(current);
    if (named.isSymbolicLink() || !named.isDirectory() || fs.realpathSync(current) !== current)
      throw new Error(`writable path redirected or not a directory: ${directory}`);
    const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd), after = fs.lstatSync(current);
      if (after.isSymbolicLink() || fs.realpathSync(current) !== current || opened.dev !== named.dev || opened.ino !== named.ino
        || opened.dev !== after.dev || opened.ino !== after.ino) throw new Error(`writable path changed: ${directory}`);
    } finally { fs.closeSync(fd); }
  }
  return absolute;
}

export function validationTemporary(cwd, { create = false } = {}) {
  const root = checkedDirectory(cwd), directory = path.join(root, '.lane/validation-tmp');
  if (create) plainDirectory(directory); // O_NOFOLLOW traversal also pins mkdir IO.
  try { return checkedDirectory(directory); }
  catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
}
