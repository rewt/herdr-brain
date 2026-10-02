import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Only an audited copy under this run's scratch root may have its modes changed.
// lstat and skipping links prevent chmod from following a link into the source.
export function makeSnapshotWritable(directory, scratchRoot) {
  const root = fs.realpathSync(scratchRoot);
  const relative = path.relative(root, fs.realpathSync(directory));
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'writable snapshot must be inside scratch');
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    assert.ok(stat.isDirectory() || stat.isFile(), `unsupported snapshot entry: ${file}`);
    fs.chmodSync(file, (stat.mode & 0o777) | (stat.isDirectory() ? 0o700 : 0o600));
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
  }
  visit(directory);
}
