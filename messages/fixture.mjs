// Stage 8 is deliberately unavailable against an identity's live storage.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function fixtureRoot(root) {
  if (!root || !path.isAbsolute(root) || fs.realpathSync(root) !== root ||
      path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !/^brain-transport-[\w-]+$/.test(path.basename(root)))
    throw Error('transport mutations require a canonical temporary brain-transport-* fixture root');
  const marker = path.join(root, 'FIXTURE');
  const stat = fs.lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(marker, 'utf8') !== 'brain.transport-fixture/v1\n')
    throw Error('transport fixture marker required');
  return root;
}

// Only a disposable enrolled fixture can fence the compatibility entrypoints.
// There is no live configuration flag or default transport state directory.
export function fixtureInboxEnrolled(file) {
  const marker = `${file}.transport-fixture`;
  if (!fs.existsSync(marker)) return false;
  const root = path.dirname(file);
  fixtureRoot(root);
  const stat = fs.lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || fs.readFileSync(marker, 'utf8') !== 'brain.transport-fixture/v1\n')
    throw Error('invalid fixture inbox fence; inspect before delivery');
  return true;
}
