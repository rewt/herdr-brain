// Rebuildable acceleration only. The JSONL file remains the sole authority.
// All hashing, snapshot I/O and full replay happen before the record lock.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { fold, extendFold } from './state.mjs';

export const SNAPSHOT_FILE = 'record.snapshot';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Different folds/readers/runtimes never reuse each other's projections. In
// particular, a pinned older reader cannot hide newly understood event types.
export const snapshotVersion = hash(Buffer.concat([
  Buffer.from(`record-snapshot/v1:${process.versions.v8}\n`),
  ...['record-snapshot.mjs', 'store.mjs', 'record-observation.mjs', 'state.mjs', 'obligations.mjs', 'discernment.mjs', 'roles.mjs', 'worker-identity.mjs']
    .map(name => fs.readFileSync(new URL(name, import.meta.url))),
]));

function identity(file, stat) {
  return { file: fs.realpathSync(file), dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) };
}
const sameIdentity = (a, b) => a.file === b.file && a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;
export function logSignature(file, fd) {
  const stat = fd === undefined ? fs.statSync(file, { bigint: true }) : fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('record log is not a supported regular file');
  return { ...identity(file, stat), size: Number(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
}
export const sameSignature = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;

function readRange(fd, start, end) {
  const bytes = Buffer.alloc(end - start);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, start + offset);
    if (!count) throw Error('record changed while reading');
    offset += count;
  }
  return bytes;
}
function digestPrefix(fd, end) {
  const digest = createHash('sha256'), buffer = Buffer.alloc(Math.min(end, 256 * 1024));
  for (let offset = 0; offset < end;) {
    const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
    if (!count) throw Error('record changed while checking its prefix');
    digest.update(buffer.subarray(0, count)); offset += count;
  }
  return digest.digest('hex');
}

function checkpoint(file, fd, source) {
  try {
    const target = path.join(path.dirname(file), SNAPSHOT_FILE);
    if (!fs.lstatSync(target).isFile()) return null;
    const bytes = fs.readFileSync(target);
    if (bytes[64] !== 10 || hash(bytes.subarray(65)) !== bytes.subarray(0, 64).toString()) return null;
    const saved = deserialize(bytes.subarray(65));
    if (saved.version !== snapshotVersion || !sameIdentity(saved.source, source) ||
        !Number.isSafeInteger(saved.offset) || saved.offset < 0 || saved.offset > source.size ||
        !Number.isSafeInteger(saved.lines) || saved.lines < 0 || !Array.isArray(saved.events) ||
        saved.state?.eventCount !== saved.events.length || !(saved.state.items instanceof Map) ||
        !(saved.state.runs instanceof Map) || saved.digest !== digestPrefix(fd, saved.offset)) return null;
    // A checkpoint always ends on a complete line, never in a torn/EOF event.
    if (saved.offset && readRange(fd, saved.offset - 1, saved.offset)[0] !== 10) return null;
    return saved;
  } catch { return null; } // Missing, corrupt, foreign or old caches rebuild.
}

function saveCheckpoint(file, data) {
  let temporary;
  try {
    const target = path.join(path.dirname(file), SNAPSHOT_FILE);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) return;
    const body = serialize(data);
    temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, Buffer.concat([Buffer.from(hash(body) + '\n'), body]), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch { /* Read-only records and failed cache writes still read the log. */ }
  finally { if (temporary) try { fs.unlinkSync(temporary); } catch {} }
}

function parseTail(bytes, lines, invalidJSON) {
  const text = bytes.toString('utf8'), parts = text.split('\n'), tail = parts.pop(), events = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].trim()) continue;
    try { events.push(JSON.parse(parts[i])); }
    catch { throw invalidJSON(lines + i + 1); }
  }
  let finalEvent, tornTail = false;
  if (tail.trim()) {
    try { finalEvent = JSON.parse(tail); }
    catch { tornTail = true; }
  }
  return { events, finalEvent, tornTail, lines: parts.length, completeBytes: bytes.lastIndexOf(10) + 1 };
}

export function readRecord(file, { snapshot = true, invalidJSON = line => Error(`invalid record JSON at line ${line}`) } = {}) {
  // Unlocked readers can race any compatible writer. Never publish a mixed view.
  for (let attempt = 0; attempt < 4; attempt++) {
    const fd = fs.openSync(file, 'r');
    try {
      const source = logSignature(file, fd);
      if (!sameSignature(source, logSignature(file))) continue;
      const saved = snapshot ? checkpoint(file, fd, source) : null;
      const offset = saved?.offset ?? 0, events = saved?.events ?? [], state = saved?.state ?? fold([]);
      let parsed;
      try { parsed = parseTail(readRange(fd, offset, source.size), saved?.lines ?? 0, invalidJSON); }
      catch (error) {
        if (!sameSignature(source, logSignature(file, fd)) || !sameSignature(source, logSignature(file))) continue;
        throw error;
      }
      const digest = digestPrefix(fd, source.size), completeOffset = offset + parsed.completeBytes;
      const completeDigest = completeOffset === source.size ? digest : digestPrefix(fd, completeOffset);
      if (!sameSignature(source, logSignature(file, fd)) || !sameSignature(source, logSignature(file))) continue;
      for (const event of parsed.events) events.push(event);
      extendFold(state, parsed.events);
      // Do not rewrite a large checkpoint for every small ordinary append.
      if (snapshot && (!saved || parsed.events.length >= 128 || completeOffset - offset >= 1024 * 1024)) {
        saveCheckpoint(file, { version: snapshotVersion, source, offset: completeOffset,
          digest: completeDigest,
          lines: (saved?.lines ?? 0) + parsed.lines, events, state });
      }
      if (parsed.finalEvent !== undefined) { events.push(parsed.finalEvent); extendFold(state, [parsed.finalEvent]); }
      return { events, state, tornTail: parsed.tornTail,
        token: { source, digest, completeOffset, finalComplete: parsed.finalEvent !== undefined },
        snapshot: { used: Boolean(saved), offset, tailEvents: parsed.events.length + (parsed.finalEvent === undefined ? 0 : 1) } };
    } finally { fs.closeSync(fd); }
  }
  throw Error('record changed repeatedly while preparing a consistent read; no mutation attempted');
}

// An explicit preparation may survive unrelated appends, but never a rewritten
// prefix. This check runs outside the lock, followed by a locked signature check.
export function unchangedPrefix(file, before, current) {
  if (!sameIdentity(before.source, current.source) || current.source.size < before.source.size) return false;
  const fd = fs.openSync(file, 'r');
  try {
    return sameSignature(current.source, logSignature(file, fd)) &&
      digestPrefix(fd, before.source.size) === before.digest && sameSignature(current.source, logSignature(file));
  } finally { fs.closeSync(fd); }
}

// Include inert/unknown events and nested references, not just folded fields.
// Callers must declare their whole dependency set; commit still checks current
// graph, claim, HOLD, effect and native/source invariants and allocates final IDs.
export function subjectVersions(events, subjects) {
  const wanted = new Set(subjects), versions = new Map([...subjects.map(id => [id, 0]), ['*', 0]]);
  const visit = (value, found) => {
    if (typeof value === 'string') {
      if (/^[A-Z][A-Z0-9]*-\d+$/.test(value)) found.add('*');
      if (wanted.has(value)) found.add(value);
    }
    else if (value && typeof value === 'object') for (const entry of Object.values(value)) visit(entry, found);
  };
  events.forEach((event, index) => {
    const found = new Set(); visit(event, found);
    if (!found.has('*')) versions.set('*', index + 1); // Unscoped control/future events invalidate all preparation.
    for (const id of found) if (id !== '*') versions.set(id, index + 1);
  });
  return versions;
}
