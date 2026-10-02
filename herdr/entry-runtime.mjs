// Herdr builds in a checkout it subsequently relocates. Entry needs its own
// stable code directory; dependency caches and project state never belong here.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncDirectory } from './entry-transaction.mjs';

const modules = ['bin', 'lib', 'lanes', 'discovery', 'herdr', 'housekeeping', 'dispatch', 'watch', 'promote', 'supervisor', 'brain', 'contrib'];
const omit = new Set(['node_modules', 'test', 'tests', 'docs', '.git', '.org', '.lane']);
function files(root) {
  const result = [];
  function visit(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) if (!omit.has(name)) visit(path.join(relative, name));
    } else if (stat.isFile()) result.push({ file: relative, data: fs.readFileSync(file), mode: stat.mode & 0o777 });
    else throw new Error(`runtime source is not a plain file: ${file}`);
  }
  for (const name of [...modules, 'package.json']) if (fs.existsSync(path.join(root, name))) visit(name);
  return result.sort((a, b) => a.file.localeCompare(b.file));
}
export function snapshot(product, runtimeRoot) {
  const contents = files(product), hash = createHash('sha256');
  for (const entry of contents) hash.update(JSON.stringify([entry.file, entry.mode, entry.data.length])).update(entry.data);
  const directory = path.join(runtimeRoot, hash.digest('hex')), created = !fs.existsSync(directory);
  if (!created) {
    const existing = files(directory);
    if (existing.length !== contents.length || existing.some((entry, i) => entry.file !== contents[i].file || entry.mode !== (contents[i].mode & ~0o222) || !entry.data.equals(contents[i].data))) throw new Error(`installed entry runtime changed: ${directory}`);
  }
  return { directory, created, prepare() {
    if (!created) return;
    fs.mkdirSync(directory, { recursive: true });
    for (const entry of contents) {
      const file = path.join(directory, entry.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'wx', entry.mode & ~0o222);
      try { fs.writeFileSync(fd, entry.data); fs.fchmodSync(fd, entry.mode & ~0o222); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    function syncTree(dir) {
      for (const name of fs.readdirSync(dir)) if (fs.lstatSync(path.join(dir, name)).isDirectory()) syncTree(path.join(dir, name));
      syncDirectory(dir);
    }
    syncTree(directory); syncDirectory(runtimeRoot);
  } };
}
