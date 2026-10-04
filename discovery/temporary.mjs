import fs from 'node:fs';
import path from 'node:path';
import { plainDirectory } from '../lib/files.mjs';
import { checkedDirectory } from './paths.mjs';

export class TemporaryError extends Error {}
export function runTemporary(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw new TemporaryError('run temp requires an absolute project fleet temp root');
  let parent = root;
  const missing = [];
  while (!fs.existsSync(parent)) { missing.unshift(path.basename(parent)); parent = path.dirname(parent); }
  const directory = path.join(checkedDirectory(parent), ...missing);
  // mkdtemp adds six characters to r-. Budget the resolved path in bytes:
  // macOS sun_path has 103 usable bytes, leaving 43 for socket filenames.
  const bytes = Buffer.byteLength(directory) + 9;
  if (bytes > 60) throw new TemporaryError(`run temp root ${directory} needs ${bytes} bytes; maximum is 60 for Unix socket paths; select a shorter fleet temp root`);
  plainDirectory(directory);
  const temporary = fs.mkdtempSync(path.join(checkedDirectory(directory), 'r-'));
  fs.chmodSync(temporary, 0o700);
  return checkedDirectory(temporary);
}
export const temporaryEnvironment = temporary => ({ TMPDIR: temporary, TMP: temporary, TEMP: temporary });
