// Herdr builds in a checkout it subsequently relocates. Entry needs its own
// stable code directory; dependency caches and project state never belong here.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncDirectory } from './entry-transaction.mjs';

const modules = ['bin', 'lib', 'lanes', 'discovery', 'herdr', 'housekeeping', 'dispatch', 'watch', 'settle', 'promote', 'supervisor', 'brain', 'contrib'];
const omit = new Set(['node_modules', 'test', 'tests', 'docs', '.git', '.org', '.lane']);
// Data read by bundled commands belongs to the distribution even under docs/.
const assets = ['package.json', 'lanes/docs/REVIEW_TEMPLATE.md'];
function files(root) {
  const result = [];
  function visit(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) if (!omit.has(name)) visit(path.join(relative, name));
    } else if (stat.isFile()) result.push({ file: relative, data: fs.readFileSync(file), mode: stat.mode & 0o777 });
    else throw new Error(`runtime source is not a plain file: ${file}`);
  }
  for (const name of [...modules, ...assets]) if (fs.existsSync(path.join(root, name))) visit(name);
  if (fs.existsSync(path.join(root, 'lanes/lane.mjs')) && !fs.existsSync(path.join(root, 'lanes/docs/REVIEW_TEMPLATE.md'))) throw new Error('entry runtime is missing the lane review template');
  return result.sort((a, b) => a.file.localeCompare(b.file));
}
export function snapshot(product, runtimeRoot, token) {
  const contents = files(product), hash = createHash('sha256');
  for (const entry of contents) hash.update(JSON.stringify([entry.file, entry.mode, entry.data.length])).update(entry.data);
  const directory = path.join(runtimeRoot, hash.digest('hex')), created = !fs.existsSync(directory);
  if (!created) {
    const existing = files(directory);
    if (existing.length !== contents.length || existing.some((entry, i) => entry.file !== contents[i].file || entry.mode !== (contents[i].mode & ~0o222) || !entry.data.equals(contents[i].data))) throw new Error(`installed entry runtime changed: ${directory}`);
  }
  const temporary = path.join(runtimeRoot, `.runtime-${token}.tmp`);
  return { directory, temporary, created, validate() {
    if (created && fs.existsSync(directory)) throw new Error(`runtime appeared during planning: ${directory}`);
  }, prepare() {
    if (!created) return;
    fs.mkdirSync(runtimeRoot, { recursive: true }); fs.mkdirSync(temporary);
    const owner = fs.openSync(path.join(temporary, '.monitor-runtime-owner.json'), 'wx', 0o400);
    try { fs.writeFileSync(owner, JSON.stringify({ token })); fs.fsyncSync(owner); }
    finally { fs.closeSync(owner); }
    syncDirectory(temporary); syncDirectory(runtimeRoot);
    for (const entry of contents) {
      const file = path.join(temporary, entry.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'wx', entry.mode & ~0o222);
      try { fs.writeFileSync(fd, entry.data); fs.fchmodSync(fd, entry.mode & ~0o222); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    function syncTree(dir) {
      for (const name of fs.readdirSync(dir)) if (fs.lstatSync(path.join(dir, name)).isDirectory()) syncTree(path.join(dir, name));
      syncDirectory(dir);
    }
    syncTree(temporary);
    this.validate(); fs.renameSync(temporary, directory); syncDirectory(runtimeRoot);
  } };
}
