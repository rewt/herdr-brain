import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fs.realpathSync(process.env.ACCEPTANCE_ROOT);
const org = process.env.ORG_DIR;
const pinned = process.env.ACCEPTANCE_PINNED_ORG;
function safe(file) {
  let ancestor = path.resolve(file);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const offset = path.relative(root, fs.realpathSync(ancestor));
  if (offset === '..' || offset.startsWith(`..${path.sep}`) || path.isAbsolute(offset)) throw new Error('record path outside scratch');
}
try {
  if (!org) throw new Error('scratch ORG_DIR required');
  safe(org);
  if (pinned && path.resolve(org) !== path.resolve(pinned)) throw new Error('copied code changed its pinned ORG_DIR');
  const args = process.argv.slice(2);
  if (args[0] === 'init') safe(args[1] ?? path.resolve('.org'));
  const child = spawnSync(process.execPath, [path.join(root, 'candidate/bin/org.mjs'), ...args], { stdio: 'inherit' });
  process.exitCode = child.status ?? 1;
} catch (error) { console.error(`acceptance record boundary: ${error.message}`); process.exitCode = 97; }
