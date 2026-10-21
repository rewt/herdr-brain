import fs from 'node:fs';
import path from 'node:path';
import { gitProject } from '../lib/project.mjs';
import { homeProject } from '../lib/config-home.mjs';

// Resolve ownership through Git, including separate git dirs and linked lanes.
// No repository basename, remote, workspace label, or session sidecar is used.
export function canonicalProject(cwd = process.cwd(), env = process.env) {
  const project = homeProject(cwd, env)?.git ?? gitProject(cwd);
  return { root: project.canonical, common: project.identity };
}

export function safeProjectPath(root, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/u).some(part => !part || part === '.' || part === '..') ||
      /[\x00-\x1f\x7f$`~:*?]/u.test(value) || value.includes('\\')) throw Error(`unsafe project path: ${value}`);
  const target = path.resolve(root, value);
  // Resolve even missing paths through their closest existing ancestor. A
  // dangling symlink is an error, never an optional absent context file.
  let parent = target;
  for (;;) {
    try {
      fs.lstatSync(parent);
      const actual = fs.realpathSync(parent), offset = path.relative(root, actual);
      if (offset === '..' || offset.startsWith(`..${path.sep}`) || path.isAbsolute(offset)) throw Error(`context path escapes project: ${value}`);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // lstat succeeded but realpath failed: a dangling symlink is unsafe.
      try { if (fs.lstatSync(parent).isSymbolicLink()) throw Error(`unsafe dangling symlink: ${value}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (parent === root) throw error;
      parent = path.dirname(parent);
    }
  }
  return target;
}
