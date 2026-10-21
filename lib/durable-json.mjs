// Atomic JSON publication with durable file and directory entries.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './files.mjs';

export function durableWrite(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', 0o600);
  for (const target of [file, path.dirname(file)]) {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
