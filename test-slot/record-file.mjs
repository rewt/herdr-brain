import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_RECORD_BYTES = 1024 * 1024;
export function readRecordBytes(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw Error('not a bounded regular record');
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (length > MAX_RECORD_BYTES) throw Error('record exceeds 1 MiB');
    return buffer.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}
export function publishRecord(file, record) {
  const bytes = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw Error('record exceeds 1 MiB');
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return bytes;
}
export function removeUnchanged(file, bytes) {
  try { if (readRecordBytes(file) === bytes) { fs.unlinkSync(file); return true; } }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  return false;
}
