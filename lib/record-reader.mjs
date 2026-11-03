// Opt-in, read-only record view. Historical payloads stay on disk; mutation
// planners continue to use store.loadRecord and its fresh locked source fences.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { fold, extendFold } from './state.mjs';
import { logSignature, sameSignature, snapshotVersion } from './record-snapshot.mjs';

export const READER_FILE = 'record.reader';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const readerVersion = digest(Buffer.concat([Buffer.from(snapshotVersion), fs.readFileSync(new URL(import.meta.url))]));
const maps = ['items', 'runs', 'lessons', 'candidates', 'workerReceipts', 'sessionBindings', 'obligations'];
const blockSize = 256 * 1024;
const footerSize = 72; // header length, header SHA256, payload SHA256
const stale = () => Object.assign(Error('compact record reader is stale; open a fresh view before planning'), { code: 'RECORD_READER_STALE' });

function bytesAt(fd, start, size) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0) throw Error('invalid reader range');
  const bytes = Buffer.alloc(size);
  for (let offset = 0; offset < size;) {
    const count = fs.readSync(fd, bytes, offset, size - offset, start + offset);
    if (!count) throw Error('record reader file changed while reading');
    offset += count;
  }
  return bytes;
}
function feed(fd, end, h) {
  const bytes = Buffer.alloc(Math.min(blockSize, end));
  for (let offset = 0; offset < end;) {
    const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, end - offset), offset);
    if (!count) throw Error('record reader source changed while hashing');
    h.update(bytes.subarray(0, count)); offset += count;
  }
  return h;
}
const hashRange = (fd, end) => feed(fd, end, createHash('sha256')).digest('hex');
function append(fd, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!count) throw Error('record reader projection write made no progress');
    offset += count;
  }
}

// Byte positions, not decoded character counts. A chunk boundary may split a
// UTF8 code point or a large event; memory is bounded by a chunk plus one line.
function* lines(fd, start, end, previousLines, invalidJSON, observe) {
  let pending = Buffer.alloc(0), line = previousLines;
  for (let offset = start; offset < end;) {
    const bytes = bytesAt(fd, offset, Math.min(blockSize, end - offset));
    observe?.(bytes);
    let from = 0;
    for (let to; (to = bytes.indexOf(10, from)) !== -1;) {
      const text = (pending.length ? Buffer.concat([pending, bytes.subarray(from, to)]) : bytes.subarray(from, to)).toString('utf8');
      let event;
      try { if (text.trim()) event = JSON.parse(text); }
      catch { throw invalidJSON(line + 1); }
      yield { event, offset: offset + to + 1, line: ++line, boundary: true, tornTail: false };
      pending = Buffer.alloc(0); from = to + 1;
    }
    pending = Buffer.concat([pending, bytes.subarray(from)]); offset += bytes.length;
  }
  if (pending.length) {
    let event, tornTail = false;
    try { if (pending.toString('utf8').trim()) event = JSON.parse(pending.toString('utf8')); }
    catch { tornTail = true; }
    yield { event, offset: end, line, boundary: false, tornTail };
  }
}

function readBlob(fd, entry) {
  const bytes = bytesAt(fd, entry.offset, entry.size);
  if (digest(bytes) !== entry.digest) throw Error('corrupt compact record payload; reopen to rebuild');
  return deserialize(bytes);
}
// A fold mutates objects obtained through get(). Evict only BETWEEN events:
// report.ingested can touch the target and arbitrarily many sibling runs.
class BuildMap {
  constructor(baseFd, index, output) {
    this.baseFd = baseFd; this.index = new Map(index); this.output = output; this.hot = new Map();
  }
  get size() { return this.index.size; }
  has(key) { return this.index.has(key); }
  get(key) {
    if (!this.hot.has(key) && this.index.has(key)) {
      const entry = this.index.get(key);
      this.hot.set(key, readBlob(entry.local ? this.output.fd : this.baseFd, entry));
    }
    return this.hot.get(key);
  }
  set(key, value) { this.index.set(key, this.index.get(key)); this.hot.set(key, value); return this; }
  *values() { this.scanned = true; for (const key of this.index.keys()) yield this.get(key); }
  // A scan has already decoded the whole map, so it stays decoded until the
  // build ends instead of being re-serialized per batch. Unchanged bytes keep
  // their original blob: reading a subject never costs a write.
  flush(final = false) {
    if (this.scanned && !final) return;
    const changed = []; let offset = this.output.offset;
    for (const [key, value] of this.hot) {
      const bytes = serialize(value), hash = digest(bytes);
      if (this.index.get(key)?.digest === hash) continue;
      changed.push(bytes);
      this.index.set(key, { offset, size: bytes.length, digest: hash, local: true });
      offset += bytes.length;
    }
    if (changed.length) append(this.output.fd, Buffer.concat(changed));
    this.output.offset = offset; this.hot.clear();
  }
}

function cached(file, logFd, source) {
  let fd;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < footerSize) throw Error('short projection');
    const footer = bytesAt(fd, size - footerSize, footerSize), length = Number(footer.readBigUInt64BE());
    const start = size - footerSize - length, headerBytes = bytesAt(fd, start, length);
    if (digest(headerBytes) !== footer.subarray(8, 40).toString('hex') || hashRange(fd, start) !== footer.subarray(40).toString('hex')) throw Error('projection checksum');
    const header = deserialize(headerBytes), saved = header.source;
    if (header.version !== readerVersion || saved.file !== source.file || saved.dev !== source.dev || saved.ino !== source.ino || saved.birth !== source.birth ||
        !Number.isSafeInteger(saved.size) || saved.size < 0 || saved.size > source.size ||
        !Number.isSafeInteger(header.line) || header.line < 0 || !Number.isSafeInteger(header.count) || header.count < 0 ||
        !Number.isSafeInteger(header.completeOffset) || header.completeOffset < 0 || header.completeOffset > saved.size ||
        typeof header.boundary !== 'boolean' || typeof header.tornTail !== 'boolean' || typeof header.finalComplete !== 'boolean' ||
        (!header.boundary && !sameSignature(saved, source)) || header.digest !== hashRange(logFd, saved.size)) throw Error('projection source');
    if (header.boundary && saved.size && bytesAt(logFd, saved.size - 1, 1)[0] !== 10) throw Error('projection boundary');
    for (const name of maps) {
      if (!Array.isArray(header.index[name])) throw Error('projection map');
      const keys = new Set();
      for (const [key, entry] of header.index[name]) {
        if (typeof key !== 'string' || keys.has(key) || !entry || !Number.isSafeInteger(entry.offset) || entry.offset < 0 ||
            !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.offset + entry.size > start || !/^[a-f0-9]{64}$/.test(entry.digest)) throw Error('projection index');
        keys.add(key);
      }
    }
    if (header.globals?.eventCount !== header.count || !Array.isArray(header.globals.links) || !Array.isArray(header.globals.categoryFlags)) throw Error('projection state');
    return { fd, header };
  } catch { if (fd !== undefined) fs.closeSync(fd); return null; }
}

function temporary(target) {
  const suffix = `.tmp-${process.pid}-${randomUUID()}`;
  try { const file = target + suffix; return { file, fd: fs.openSync(file, 'wx+', 0o600) }; }
  catch { const file = path.join(os.tmpdir(), 'record-reader' + suffix); return { file, fd: fs.openSync(file, 'wx+', 0o600) }; }
}
function rebuild(target, logFd, source, saved, invalidJSON) {
  // Anonymous and created last, so a killed build leaves no scratch behind.
  const spool = temporary(target), output = { fd: spool.fd, offset: 0 };
  fs.unlinkSync(spool.file);
  let result;
  try {
    const initial = saved?.header, state = initial ? structuredClone(initial.globals) : fold([]);
    for (const name of maps) state[name] = new BuildMap(saved?.fd, initial?.index[name] ?? [], output);
    let line = initial?.line ?? 0, boundary = initial?.boundary ?? true, tornTail = initial?.tornTail ?? false, lastSeq = initial?.lastSeq ?? null, completeOffset = initial?.completeOffset ?? 0, finalComplete = initial?.finalComplete ?? false;
    let batch = 0;
    // The digest covers the bytes actually folded, so a projection published
    // after the record moved can never claim a prefix rewritten under this build.
    const folded = createHash('sha256');
    if (initial && feed(logFd, initial.source.size, folded).copy().digest('hex') !== initial.digest) throw Error('record reader source changed while hashing');
    for (const row of lines(logFd, initial?.source.size ?? 0, source.size, line, invalidJSON, bytes => folded.update(bytes))) {
      ({ line, boundary, tornTail } = row);
      finalComplete = !boundary && row.event !== undefined;
      if (boundary) completeOffset = row.offset;
      if (row.event !== undefined) { extendFold(state, [row.event]); lastSeq = row.event.seq ?? null; }
      // Retain at most 128 events' touched subjects, plus a single event's
      // dependency set. No decoded archive survives an open reader.
      if (++batch === 128) { for (const name of maps) state[name].flush(); batch = 0; }
    }
    for (const name of maps) state[name].flush(true);
    result = temporary(target);
    const index = {}, globals = { ...state }; let position = 0;
    const payloadHash = createHash('sha256');
    let pending = [], pendingBytes = 0;
    const drain = () => { if (pendingBytes) append(result.fd, Buffer.concat(pending)); pending = []; pendingBytes = 0; };
    for (const name of maps) {
      index[name] = [];
      for (const [key, entry] of state[name].index) {
        const bytes = bytesAt(entry.local ? spool.fd : saved.fd, entry.offset, entry.size);
        pending.push(bytes); pendingBytes += bytes.length; payloadHash.update(bytes);
        if (pendingBytes >= blockSize) drain();
        index[name].push([key, { offset: position, size: bytes.length, digest: entry.digest }]); position += bytes.length;
      }
      delete globals[name];
    }
    drain();
    const header = { version: readerVersion, source, digest: folded.digest('hex'), line, boundary, tornTail,
      completeOffset, finalComplete, count: state.eventCount, lastSeq, globals, index };
    const bytes = serialize(header), footer = Buffer.alloc(footerSize);
    footer.writeBigUInt64BE(BigInt(bytes.length)); Buffer.from(digest(bytes), 'hex').copy(footer, 8); payloadHash.digest().copy(footer, 40);
    append(result.fd, bytes); append(result.fd, footer);
    return { ...result, header };
  } catch (error) { if (result) { fs.closeSync(result.fd); fs.unlinkSync(result.file); } throw error; }
  finally { fs.closeSync(spool.fd); }
}

class ReadMap {
  constructor(fd, entries, assertOpen) { this.fd = fd; this.index = new Map(entries); this.assertOpen = assertOpen; }
  get size() { this.assertOpen(); return this.index.size; }
  has(key) { this.assertOpen(); return this.index.has(key); }
  get(key) { this.assertOpen(); const entry = this.index.get(key); return entry ? readBlob(this.fd, entry) : undefined; }
  *keys() { this.assertOpen(); yield* this.index.keys(); }
  *values() { for (const key of this.keys()) yield this.get(key); }
  *entries() { for (const key of this.keys()) yield [key, this.get(key)]; }
  [Symbol.iterator]() { return this.entries(); }
}

/** Open a point-in-time, exact folded view. Close explicitly, retain only selected
 * subjects, and reopen when fresh() is false. This API never authorizes effects. */
export function openRecordReader(file, { invalidJSON = line => Error(`invalid record JSON at line ${line}`) } = {}) {
  const target = path.join(path.dirname(file), READER_FILE);
  for (let attempt = 0; attempt < 4; attempt++) {
    const logFd = fs.openSync(file, 'r'); let projection, built, keep = false;
    try {
      const source = logSignature(file, logFd);
      if (!sameSignature(source, logSignature(file))) continue;
      projection = cached(target, logFd, source);
      const used = Boolean(projection), offset = projection?.header.source.size ?? 0;
      const oldCount = projection?.header.count ?? 0;
      if (!projection || !sameSignature(projection.header.source, source)) {
        try { built = rebuild(target, logFd, source, projection, invalidJSON); }
        catch (error) {
          if (!sameSignature(source, logSignature(file, logFd)) || !sameSignature(source, logSignature(file))) continue;
          throw error;
        }
        if (projection) fs.closeSync(projection.fd);
        projection = built;
      }
      const current = sameSignature(source, logSignature(file, logFd)) && sameSignature(source, logSignature(file));
      // Immutable replacement: already-open readers retain their own generation.
      // Publish even if the record moved: on a busy record the next attempt and
      // later readers extend this build instead of starting again. cached() still
      // verifies its prefix. A torn final line can only be reused while unmoved.
      if (built && (current || built.header.boundary)) try {
        if (!fs.existsSync(target) || fs.lstatSync(target).isFile()) { fs.renameSync(built.file, target); built.file = null; }
      } catch { /* A read-only record still provides an uncached compact view. */ }
      if (!current) continue;
      let closed = false;
      const assertOpen = () => { if (closed) throw Error('compact record reader is closed'); };
      const fresh = () => { assertOpen(); try { return sameSignature(source, logSignature(file)) && sameSignature(source, logSignature(file, logFd)); } catch { return false; } };
      const verify = () => { if (!fresh()) throw stale(); };
      const { header } = projection, state = structuredClone(header.globals);
      for (const name of maps) state[name] = new ReadMap(projection.fd, header.index[name], assertOpen);
      const position = Object.freeze({ version: readerVersion, source: Object.freeze({ ...source }), digest: header.digest,
        bytes: source.size, completeBytes: header.completeOffset, finalComplete: header.finalComplete, events: header.count, lastSeq: header.lastSeq, lastAt: state.lastAt });
      const reader = {
        state, position, tornTail: header.tornTail, snapshot: { used, offset, tailEvents: header.count - oldCount },
        fresh, verify,
        *events({ afterSeq } = {}) {
          verify();
          try { for (const row of lines(logFd, 0, source.size, 0, invalidJSON)) if (row.event !== undefined &&
            (afterSeq === undefined || !Number.isFinite(row.event.seq) || row.event.seq > afterSeq)) yield row.event; }
          finally { verify(); }
        },
        close() {
          if (closed) return;
          closed = true; fs.closeSync(logFd); fs.closeSync(projection.fd);
          if (built?.file) fs.unlinkSync(built.file);
        },
      };
      keep = true; return reader;
    } finally {
      if (!keep) {
        fs.closeSync(logFd); if (projection) fs.closeSync(projection.fd);
        if (built?.file) try { fs.unlinkSync(built.file); } catch {}
      }
    }
  }
  throw Error('record changed repeatedly while preparing a compact read; no mutation attempted');
}
